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

    const c: httpClient = {
      url: url,
      c: new hc.HttpClient('actions-wait-rollout', [], {
        headers: {
          authorization: `Bearer ${token}`
        }
      })
    }

    await waitRollout(c, rolloutName)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function waitRollout(c: httpClient, rolloutName: string) {
  const r = await getRollout(c, rolloutName)
  const stageCount = r.stages.length
  if (stageCount === 0) {
    return
  }

  core.info(`The rollout has ${stageCount} stages:`)
  core.info(r.stages.map((e: { title: string }) => e.title).join('\n'))

  let i = 0
  while (true) {
    if (i >= stageCount) {
      break
    }

    const r = await getRollout(c, rolloutName)
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
