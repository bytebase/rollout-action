import * as core from '@actions/core'
import * as hc from '@actions/http-client'
import { gte } from 'semver'
import { sleep } from './utils'

const minimumBytebaseVersion = '3.5.0'

// Action parameters.
const bbUrl = core.getInput('url', { required: true })
const token = core.getInput('token', { required: true })
const planName = core.getInput('plan', { required: true })
const targetStage = core.getInput('target-stage', { required: true })
const rolloutTitle = core.getInput('rollout-title')

// The common HTTP client for the action.
const c = new hc.HttpClient('rollout-action', [], {
  headers: {
    authorization: `Bearer ${token}`
  }
})

// The created rollout name in this action.
// Using to cancel the rollout when the action is cancelled.
let createdRollout: string | undefined = undefined

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    if (targetStage === '') {
      throw new Error('target stage cannot be empty')
    }

    const m = planName.match(/(?<project>projects\/.*)\/plans\/.*/)
    if (!m || !m.groups || !m.groups['project']) {
      throw new Error(`failed to extract project from plan ${planName}`)
    }
    const project = m.groups['project']

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
    // Cache created rollout name to cancel it when the action is cancelled.
    createdRollout = rollout.name

    core.info(`Rollout created. View at ${bbUrl}/${rollout.name} on Bytebase.`)

    await waitRollout(c, project, rolloutPreview, rollout.name, targetStage)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function waitRollout(
  c: hc.HttpClient,
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

async function getRollout(c: hc.HttpClient, rollout: string) {
  const url = `${bbUrl}/v1/${rollout}`
  const response = await c.getJson<any>(url)

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
  c: hc.HttpClient,
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
  let url = `${bbUrl}/v1/${project}/rollouts`
  if (params.length > 0) {
    url = url + '?' + params.join('&')
  }

  const request = {
    plan: plan,
    title: rolloutTitle
  }

  const response = await c.postJson<{
    message: string
  }>(url, request)

  if (response.statusCode !== 200) {
    throw new Error(
      `failed to create rollout, ${response.statusCode}, ${response.result?.message}`
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

async function runStageTasks(c: hc.HttpClient, stage: any) {
  const stageName = stage.name
  const taskNames = stage.tasks
    .filter((e: { status: string }) => e.status === 'NOT_STARTED')
    .map((e: { name: string }) => e.name)
  if (taskNames.length === 0) {
    return
  }
  const url = `${bbUrl}/v1/${stageName}/tasks:batchRun`
  const request = {
    tasks: taskNames,
    reason: `run ${stage.environment}`
  }

  try {
    const response = await c.postJson<any>(url, request)
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

async function assertBytebaseVersion(c: hc.HttpClient) {
  const response = await c.getJson<{ version: string }>(
    `${bbUrl}/v1/actuator/info`
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

async function cancelRollout(c: hc.HttpClient) {
  if (!createdRollout) {
    return
  }

  const listTaskRunsResponse = await c.getJson<{
    taskRuns: {
      name: string
      status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELED'
    }[]
  }>(`${bbUrl}/v1/${createdRollout}/stages/-/tasks/-/taskRuns`)
  if (listTaskRunsResponse.statusCode !== 200) {
    throw new Error(
      `failed to list task runs, status code: ${listTaskRunsResponse.statusCode}`
    )
  }
  if (!listTaskRunsResponse.result) {
    throw new Error(`list task runs not found`)
  }
  const taskRuns = listTaskRunsResponse.result.taskRuns.filter(
    t => t.status === 'PENDING' || t.status === 'RUNNING'
  )
  if (!Array.isArray(taskRuns) || taskRuns.length === 0) {
    core.info('no task runs found, nothing to cancel')
    return
  }

  core.info(
    `batch canceling task runs: ${taskRuns.map(t => t.name).join(', ')}`
  )

  // Format: stages/<stageId>
  let stageId = ''
  for (const taskRun of taskRuns) {
    const m = taskRun.name.match(/(?<stageId>stages\/\d+)/)
    if (!m || !m.groups || !m.groups['stageId']) {
      throw new Error(`failed to extract stage id from task run name`)
    }
    stageId = m.groups['stageId']
  }
  if (!stageId) {
    throw new Error(`failed to extract stage id from task run name`)
  }

  try {
    const url = `${bbUrl}/v1/${createdRollout}/${stageId}/tasks/-/taskRuns:batchCancel`
    await c.postJson(url, {
      taskRuns: taskRuns.map(t => t.name)
    })
    core.info(`task runs canceled: ${taskRuns.map(t => t.name).join(', ')}`)
  } catch (error) {
    core.warning(`failed to cancel task runs, ${error}, please cancel manually`)
  }
}

process.on('SIGINT', async () => {
  core.warning('Cancellation signal (SIGINT) received.')
  await cancelRollout(c)
  process.exit(0)
})

process.on('SIGTERM', async () => {
  core.warning('Cancellation signal (SIGTERM) received.')
  await cancelRollout(c)
  process.exit(0)
})
