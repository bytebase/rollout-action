import * as core from '@actions/core'
import * as hc from '@actions/http-client'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const url = core.getInput('url', { required: true })
    const token = core.getInput('token', { required: true })
    const rolloutName = core.getInput('rollout', { required: true })

    const m = rolloutName.match(/(?<project>projects\/.*)\/rollouts\/.*/)
    if (!m || !m.groups || !m.groups['project']) {
      throw new Error(`failed to extract project from rollout ${rolloutName}`)
    }
    const project = m.groups['project']

    const c: httpClient = {
      url: url,
      c: new hc.HttpClient('actions-wait-rollout', [], {
        headers: {
          authorization: `Bearer ${token}`
        }
      })
    }

    const rollout = await getRollout(c, rolloutName)
    const planName = rollout.plan as string
    if (!planName) {
      core.debug(`rollout: ${JSON.stringify(rollout)}`)
      throw new Error(`failed to get rollout.plan`)
    }

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

    await waitRollout(c, project, rolloutPreview, rolloutName)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function waitRollout(
  c: httpClient,
  project: string,
  rolloutPreview: any,
  rolloutName: string
) {
  const stageCount = rolloutPreview.stages.length
  if (stageCount === 0) {
    return
  }

  core.info(`The rollout has ${stageCount} stages:`)
  core.info(
    rolloutPreview.stages.map((e: { title: string }) => e.title).join('\n')
  )

  let i = 0
  while (true) {
    if (i >= stageCount) {
      break
    }

    let r = await getRollout(c, rolloutName)
    // The stage is not created yet.
    // We need to create it.
    if (r.stages.length <= i) {
      r = await createRollout(
        c,
        project,
        rolloutPreview.plan,
        false,
        rolloutPreview.stages[i].id
      )
    }
    const stage = r.stages[i]
    const { done, failedTasks } = getStageStatus(stage)
    if (done) {
      core.info(`${stage.title} done`)
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
  stageId: string | undefined
): Promise<any> {
  const params: string[] = []
  if (validateOnly) {
    params.push('validateOnly=true')
  }
  if (stageId) {
    params.push(`stageId=${stageId}`)
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
    done: stage.tasks.every((e: { status: string }) => e.status === 'DONE'),
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
    reason: `run ${stage.title}`
  }
  const response = await c.c.postJson<any>(url, request)

  if (response.statusCode !== 200) {
    throw new Error(
      `failed to run tasks, ${response.statusCode}, ${response.result.message}`
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
