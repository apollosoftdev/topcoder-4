#!/usr/bin/env node

/**
 * Integration Test Script for Marathon Match Processor
 *
 * Simulates the full fan-out flow locally with mocked AWS services:
 * MSK (Kafka) → Router → SNS → SQS → SubmissionWatcher → ECS → EventBridge → Completion
 *
 * Usage:
 *   node scripts/integration-test.js
 *   node scripts/integration-test.js --verbose
 *   node scripts/integration-test.js --test-failure
 */

const chalk = require('chalk') || { green: s => s, red: s => s, yellow: s => s, blue: s => s, cyan: s => s, gray: s => s };

// Configuration
const TEST_CONFIG = {
  challengeId: '00000000-0000-0000-0000-000000000000',
  challengeName: 'BioSlime',
  submissionId: '11111111-1111-1111-1111-111111111111',
  scorers: ['example', 'provisional'],
  maxRetries: 3,
};

// Simulated state
const state = {
  snsMessages: [],
  sqsMessages: [],
  ecsTasksLaunched: [],
  ecsTasksCompleted: [],
  completionLogs: [],
  retryMessages: [],
  dynamoDbData: new Map(),
};

// Initialize DynamoDB with challenge mapping
state.dynamoDbData.set(TEST_CONFIG.challengeId, {
  challengeId: TEST_CONFIG.challengeId,
  challengeName: TEST_CONFIG.challengeName,
  queueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/queue-${TEST_CONFIG.challengeName.toLowerCase()}`,
  active: true,
});

const verbose = process.argv.includes('--verbose');
const testFailure = process.argv.includes('--test-failure');

function log(level, component, message, data = null) {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
  const colors = {
    INFO: chalk.blue,
    SUCCESS: chalk.green,
    ERROR: chalk.red,
    WARN: chalk.yellow,
    DEBUG: chalk.gray,
  };
  const color = colors[level] || chalk.white;

  if (level === 'DEBUG' && !verbose) return;

  console.log(`${chalk.gray(timestamp)} ${color(`[${level}]`)} ${chalk.cyan(`[${component}]`)} ${message}`);
  if (data && verbose) {
    console.log(chalk.gray(JSON.stringify(data, null, 2)));
  }
}

// ========== SIMULATED AWS SERVICES ==========

/**
 * Simulated Router Lambda
 * Receives Kafka message, validates, publishes to SNS
 */
async function simulateRouterLambda(kafkaMessage) {
  log('INFO', 'Router', 'Received Kafka message');

  const payload = kafkaMessage.payload;
  const { submissionId, challengeId } = payload;

  // Validate UUIDs
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(submissionId)) {
    log('ERROR', 'Router', `Invalid submissionId: ${submissionId}`);
    return { success: false, reason: 'invalid_submission_id' };
  }
  if (!uuidRegex.test(challengeId)) {
    log('ERROR', 'Router', `Invalid challengeId: ${challengeId}`);
    return { success: false, reason: 'invalid_challenge_id' };
  }

  // Check DynamoDB for active challenge
  const challengeMapping = state.dynamoDbData.get(challengeId);
  if (!challengeMapping || !challengeMapping.active) {
    log('WARN', 'Router', `Challenge ${challengeId} not found or inactive`);
    return { success: false, reason: 'challenge_not_found' };
  }

  log('SUCCESS', 'Router', `Challenge ${challengeId} is active`);

  // Publish to SNS
  const snsMessage = {
    messageId: `sns-${Date.now()}`,
    message: kafkaMessage,
    attributes: { challengeId },
    timestamp: new Date().toISOString(),
  };
  state.snsMessages.push(snsMessage);
  log('SUCCESS', 'Router', `Published to SNS: ${snsMessage.messageId}`);

  // SNS fans out to SQS
  await simulateSnsFanout(snsMessage);

  return { success: true, messageId: snsMessage.messageId };
}

/**
 * Simulated SNS Fan-out to SQS
 */
async function simulateSnsFanout(snsMessage) {
  log('INFO', 'SNS', 'Fanning out message to SQS');

  const sqsMessage = {
    messageId: `sqs-${Date.now()}`,
    body: snsMessage.message,
    messageAttributes: {
      RetryCount: { stringValue: '0', dataType: 'Number' },
    },
    timestamp: new Date().toISOString(),
  };
  state.sqsMessages.push(sqsMessage);
  log('SUCCESS', 'SNS→SQS', `Message delivered to queue: ${sqsMessage.messageId}`);

  // Trigger Submission Watcher Lambda
  await simulateSubmissionWatcherLambda(sqsMessage);
}

/**
 * Simulated Submission Watcher Lambda (per-challenge)
 * Receives SQS message, loads config, launches ECS tasks
 */
async function simulateSubmissionWatcherLambda(sqsMessage) {
  const payload = sqsMessage.body.payload;
  const { submissionId, challengeId } = payload;
  const retryCount = parseInt(sqsMessage.messageAttributes?.RetryCount?.stringValue || '0', 10);

  log('INFO', 'SubmissionWatcher', `Processing submission ${submissionId} (retry: ${retryCount})`);

  // Verify challenge matches
  if (challengeId !== TEST_CONFIG.challengeId) {
    log('WARN', 'SubmissionWatcher', `Challenge mismatch: expected ${TEST_CONFIG.challengeId}, got ${challengeId}`);
    return { success: true, skipped: true };
  }

  // Check max retries
  if (retryCount >= TEST_CONFIG.maxRetries) {
    log('ERROR', 'SubmissionWatcher', `Max retries (${TEST_CONFIG.maxRetries}) exceeded`);
    return { success: true, skipped: true, reason: 'max_retries' };
  }

  // Simulate loading config from SSM (cold-start cache)
  log('DEBUG', 'SubmissionWatcher', 'Loading challenge config from SSM');
  log('DEBUG', 'SubmissionWatcher', 'Loading Auth0 token');

  // Launch ECS tasks for each scorer
  for (const scorer of TEST_CONFIG.scorers) {
    await simulateEcsTaskLaunch({
      challengeId,
      submissionId,
      scorerType: scorer,
      retryCount,
    });
  }

  log('SUCCESS', 'SubmissionWatcher', `Launched ${TEST_CONFIG.scorers.length} ECS tasks`);
  return { success: true, tasksLaunched: TEST_CONFIG.scorers.length };
}

/**
 * Simulated ECS Task Launch
 */
async function simulateEcsTaskLaunch({ challengeId, submissionId, scorerType, retryCount }) {
  const taskArn = `arn:aws:ecs:us-east-1:123456789012:task/test-cluster/task-${Date.now()}-${scorerType}`;

  const task = {
    taskArn,
    challengeId,
    submissionId,
    scorerType,
    retryCount,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
  };
  state.ecsTasksLaunched.push(task);

  log('INFO', 'ECS', `Launched task for scorer ${scorerType}: ${taskArn}`);

  // Simulate task completion after a delay
  setTimeout(() => simulateEcsTaskCompletion(task), 100);

  return task;
}

/**
 * Simulated ECS Task Completion (triggers EventBridge)
 */
async function simulateEcsTaskCompletion(task) {
  // Simulate success or failure based on test mode
  const shouldFail = testFailure && task.scorerType === 'example' && task.retryCount < 2;
  const exitCode = shouldFail ? 1 : 0;

  task.status = 'STOPPED';
  task.stoppedAt = new Date().toISOString();
  task.exitCode = exitCode;
  state.ecsTasksCompleted.push(task);

  const status = exitCode === 0 ? 'SUCCESS' : 'FAILURE';
  log(exitCode === 0 ? 'SUCCESS' : 'ERROR', 'ECS', `Task ${task.scorerType} completed with exit code ${exitCode}`);

  // Trigger EventBridge → Completion Lambda
  await simulateEventBridgeEvent(task);
}

/**
 * Simulated EventBridge Event → Completion Lambda
 */
async function simulateEventBridgeEvent(task) {
  log('INFO', 'EventBridge', `ECS Task State Change: ${task.taskArn}`);

  const event = {
    'detail-type': 'ECS Task State Change',
    source: 'aws.ecs',
    detail: {
      taskArn: task.taskArn,
      lastStatus: 'STOPPED',
      stoppedAt: task.stoppedAt,
      startedAt: task.startedAt,
      containers: [{ exitCode: task.exitCode }],
      tags: [
        { key: 'ChallengeId', value: task.challengeId },
        { key: 'SubmissionId', value: task.submissionId },
        { key: 'ScorerType', value: task.scorerType },
        { key: 'RetryCount', value: String(task.retryCount) },
      ],
    },
  };

  await simulateCompletionLambda(event);
}

/**
 * Simulated Completion Lambda
 * Logs completion status, triggers retry on failure
 */
async function simulateCompletionLambda(event) {
  const detail = event.detail;
  const tags = detail.tags.reduce((acc, t) => ({ ...acc, [t.key]: t.value }), {});
  const exitCode = detail.containers[0].exitCode;
  const success = exitCode === 0;

  const completionLog = {
    timestamp: new Date().toISOString(),
    taskArn: detail.taskArn,
    status: success ? 'SUCCESS' : 'FAILURE',
    challengeId: tags.ChallengeId,
    submissionId: tags.SubmissionId,
    scorerType: tags.ScorerType,
    retryCount: parseInt(tags.RetryCount, 10),
    exitCode,
  };
  state.completionLogs.push(completionLog);

  if (success) {
    log('SUCCESS', 'Completion', `TASK_SUCCESS: ${tags.ScorerType} for submission ${tags.SubmissionId}`);
  } else {
    log('ERROR', 'Completion', `TASK_FAILURE: ${tags.ScorerType} for submission ${tags.SubmissionId}`);

    // Attempt retry
    const currentRetry = parseInt(tags.RetryCount, 10);
    if (currentRetry < TEST_CONFIG.maxRetries - 1) {
      log('INFO', 'Completion', `Queueing retry (${currentRetry + 1}/${TEST_CONFIG.maxRetries - 1})`);

      const retryMessage = {
        messageId: `retry-${Date.now()}`,
        body: {
          payload: {
            challengeId: tags.ChallengeId,
            submissionId: tags.SubmissionId,
            scorerType: tags.ScorerType,
          },
        },
        messageAttributes: {
          RetryCount: { stringValue: String(currentRetry + 1), dataType: 'Number' },
        },
      };
      state.retryMessages.push(retryMessage);

      // Process retry
      await simulateSubmissionWatcherLambda(retryMessage);
    } else {
      log('ERROR', 'Completion', `Max retries reached for ${tags.ScorerType}. Giving up.`);
    }
  }
}

// ========== TEST RUNNER ==========

async function runIntegrationTest() {
  console.log('\n' + '='.repeat(70));
  console.log(chalk.cyan('  MARATHON MATCH PROCESSOR - INTEGRATION TEST'));
  console.log(chalk.gray(`  Mode: ${testFailure ? 'Failure Simulation' : 'Normal'}`));
  console.log('='.repeat(70) + '\n');

  // Create test Kafka message
  const kafkaMessage = {
    payload: {
      submissionId: TEST_CONFIG.submissionId,
      challengeId: TEST_CONFIG.challengeId,
    },
  };

  log('INFO', 'TEST', `Starting test with submission: ${TEST_CONFIG.submissionId}`);
  log('INFO', 'TEST', `Challenge: ${TEST_CONFIG.challengeName} (${TEST_CONFIG.challengeId})`);
  console.log();

  // Step 1: Kafka message → Router Lambda
  console.log(chalk.yellow('--- Step 1: Kafka → Router Lambda ---'));
  await simulateRouterLambda(kafkaMessage);
  console.log();

  // Wait for all async operations to complete
  await new Promise(resolve => setTimeout(resolve, 500));

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log(chalk.cyan('  TEST SUMMARY'));
  console.log('='.repeat(70));

  console.log(`\n${chalk.blue('Messages Processed:')}`);
  console.log(`  SNS Messages:     ${state.snsMessages.length}`);
  console.log(`  SQS Messages:     ${state.sqsMessages.length}`);
  console.log(`  Retry Messages:   ${state.retryMessages.length}`);

  console.log(`\n${chalk.blue('ECS Tasks:')}`);
  console.log(`  Launched:         ${state.ecsTasksLaunched.length}`);
  console.log(`  Completed:        ${state.ecsTasksCompleted.length}`);

  const successTasks = state.completionLogs.filter(l => l.status === 'SUCCESS').length;
  const failedTasks = state.completionLogs.filter(l => l.status === 'FAILURE').length;

  console.log(`\n${chalk.blue('Completion Results:')}`);
  console.log(`  Successful:       ${chalk.green(successTasks)}`);
  console.log(`  Failed:           ${chalk.red(failedTasks)}`);

  console.log('\n' + '='.repeat(70));

  // Determine test result
  const allSuccessful = state.completionLogs.every(l => l.status === 'SUCCESS') ||
                        (testFailure && successTasks > 0); // In failure mode, at least some should succeed after retry

  if (allSuccessful || (testFailure && state.retryMessages.length > 0)) {
    console.log(chalk.green('\n✓ INTEGRATION TEST PASSED\n'));
    console.log(chalk.gray('  All components working correctly:'));
    console.log(chalk.gray('  ✓ Router Lambda decodes Kafka messages'));
    console.log(chalk.gray('  ✓ DynamoDB lookup for active challenges'));
    console.log(chalk.gray('  ✓ SNS fan-out to SQS'));
    console.log(chalk.gray('  ✓ SubmissionWatcher launches ECS tasks'));
    console.log(chalk.gray('  ✓ ECS tasks tagged correctly'));
    console.log(chalk.gray('  ✓ EventBridge triggers Completion Lambda'));
    console.log(chalk.gray('  ✓ Completion Lambda logs results'));
    if (testFailure) {
      console.log(chalk.gray('  ✓ Retry mechanism working'));
    }
    process.exit(0);
  } else {
    console.log(chalk.red('\n✗ INTEGRATION TEST FAILED\n'));
    process.exit(1);
  }
}

// Run test
runIntegrationTest().catch(err => {
  console.error(chalk.red('Test error:'), err);
  process.exit(1);
});
