import * as core from '@actions/core'
import * as hc from '@actions/http-client'
import { gte } from 'semver'

const minimumBytebaseVersion = '3.5.0'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const url = core.getInput('url', { required: true })
    const token = core.getInput('token', { required: true })
    const planName = core.getInput('plan', { required: true })
    const targetStage = core.getInput('target-stage', { required: true })

    if (targetStage === '') {
      throw new Error('target stage cannot be empty')
    }

    const m = planName.match(/(?<project>projects\/.*)\/plans\/.*/)
    if (!m || !m.groups || !m.groups['project']) {
      throw new Error(`failed to extract project from plan ${planName}`)
    }
    const project = m.groups['project']

    const c: httpClient = {
      url: url,
      c: new hc.HttpClient('rollout-action', [], {
        headers: {
          authorization: `Bearer ${token}`
        }
      })
    }

    assertBytebaseVersion(c)

    // Preview the rollout.
    // The rollout may have no stages. We need to create stages as we are moving through the pipeline.
    const rolloutPreview = await createRollout(
      c,
      project,
      planName,
      true,
      undefined
    )
    rolloutPreview.plan = planName

    if (
      !rolloutPreview.stages.some(
        (e: { environment: string }) => e.environment === targetStage
      )
    ) {
      throw new Error(`target stage ${targetStage} not found
available stages:
${rolloutPreview.stages
  .map((e: { environment: string }) => e.environment)
  .join('\n')}`)
    }

    // Create the rollout without any stage to obtain the rollout resource name.
    const rollout = await createRollout(c, project, planName, false, '')

    core.info(`Rollout created. View at ${c.url}/${rollout.name} on Bytebase.`)

    await waitRollout(c, project, rolloutPreview, rollout.name, targetStage)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function waitRollout(
  c: httpClient,
  project: string,
  rolloutPreview: any,
  rolloutName: string,
  targetStage: string
) {
  const stageCount = rolloutPreview.stages.length
  if (stageCount === 0) {
    return
  }
  core.info(`Exit after the stage '${targetStage}' is completed`)
  core.info(`The rollout has ${stageCount} stages:`)
  core.info(
    rolloutPreview.stages
      .map((e: { environment: string }) => e.environment)
      .join('\n')
  )

  let i = 0
  while (true) {
    if (i >= stageCount) {
      break
    }

    let r = await getRollout(c, rolloutName)
    // The stage is not created yet.
    // We need to create it.
    if ((r.stages?.length ?? 0) <= i) {
      r = await createRollout(
        c,
        project,
        rolloutPreview.plan,
        false,
        rolloutPreview.stages[i].environment
      )
    }
    const stage = r.stages[i]
    const { done, failedTasks } = getStageStatus(stage)
    if (done) {
      core.info(`${stage.environment} done`)
      if (stage.environment === targetStage) {
        return
      }
      i++
      continue
    }
    if (failedTasks.length > 0) {
      throw new Error(
        `task ${failedTasks.map((e: { name: any }) => e.name)} failed`
      )
    }

    await runStageTasks(c, stage)
    await sleep(5000)
  }
}

async function getRollout(c: httpClient, rollout: string) {
  const url = `${c.url}/v1/${rollout}`
  const response = await c.c.getJson<any>(url)

  if (response.statusCode !== 200) {
    throw new Error(
      `failed to get rollout, ${response.statusCode}, ${response.result.message}`
    )
  }

  if (!response.result) {
    throw new Error(`rollout not found`)
  }

  return response.result
}

async function createRollout(
  c: httpClient,
  project: string,
  plan: string,
  validateOnly: boolean,
  targetStage: string | undefined
): Promise<any> {
  const params: string[] = []
  if (validateOnly) {
    params.push('validateOnly=true')
  }
  if (targetStage !== undefined) {
    params.push(`target=${targetStage}`)
  }
  let url = `${c.url}/v1/${project}/rollouts`
  if (params.length > 0) {
    url = url + '?' + params.join('&')
  }

  const request = {
    plan: plan
  }

  const response = await c.c.postJson<{
    message: string
  }>(url, request)

  if (response.statusCode !== 200) {
    throw new Error(
      `failed to create release, ${response.statusCode}, ${response.result?.message}`
    )
  }

  if (!response.result) {
    throw new Error(`expect result to be not null, get ${response.result}`)
  }

  return response.result
}

function getStageStatus(stage: any) {
  return {
    done: stage.tasks.every(
      (e: { status: string }) => e.status === 'DONE' || e.status === 'SKIPPED'
    ),
    failedTasks: stage.tasks.filter(
      (e: { status: string }) => e.status === 'FAILED'
    )
  }
}

async function runStageTasks(c: httpClient, stage: any) {
  const stageName = stage.name
  const taskNames = stage.tasks
    .filter((e: { status: string }) => e.status === 'NOT_STARTED')
    .map((e: { name: string }) => e.name)
  if (taskNames.length === 0) {
    return
  }
  const url = `${c.url}/v1/${stageName}/tasks:batchRun`
  const request = {
    tasks: taskNames,
    reason: `run ${stage.environment}`
  }

  try {
    const response = await c.c.postJson<any>(url, request)
    if (response.statusCode !== 200) {
      throw new Error(
        `failed to run tasks, ${response.statusCode}, ${response.result.message}`
      )
    }
  } catch (e: any) {
    const err = e as hc.HttpClientError
    if (
      err.message.includes(
        'cannot create pending task runs because there are pending/running/done task runs'
      )
    ) {
      core.info(`encounter retryable error: ${err.message}, will retry`)
    } else {
      throw e
    }
  }
}

async function assertBytebaseVersion(c: httpClient) {
  const response = await c.c.getJson<{ version: string }>(
    `${c.url}/v1/actuator/info`
  )
  if (response.statusCode !== 200) {
    throw new Error(
      `failed to get actuator info, status code: ${response.statusCode}`
    )
  }
  if (!response.result) {
    throw new Error(`actuator info not found`)
  }

  if (!gte(response.result.version, minimumBytebaseVersion)) {
    throw new Error(
      `Bytebase version ${response.result.version} is not supported. Please upgrade to ${minimumBytebaseVersion} or later.`
    )
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
interface httpClient {
  c: hc.HttpClient
  url: string
}
