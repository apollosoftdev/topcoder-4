/**
 * Completion Lambda
 * Triggered by EventBridge when ECS tasks stop
 * Logs task completion status and retries failed tasks via SQS
 */

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

const sqs = new SQSClient();
const dynamodb = new DynamoDBClient();

// Configuration from environment variables
const config = {
  challengeMappingTable: process.env.CHALLENGE_MAPPING_TABLE,
  maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
};

/**
 * Extract tags from ECS task as a key-value object
 * @param {Array} tags - Array of tag objects {key, value}
 * @returns {Object} - Tags as key-value pairs
 */
const extractTags = (tags) => {
  if (!Array.isArray(tags)) {
    return {};
  }
  return tags.reduce((acc, tag) => {
    if (tag.key && tag.value) {
      acc[tag.key] = tag.value;
    }
    return acc;
  }, {});
};

/**
 * Extract container exit information
 * @param {Array} containers - Array of container objects from task detail
 * @returns {Object} - Container exit information
 */
const extractContainerInfo = (containers) => {
  if (!Array.isArray(containers) || containers.length === 0) {
    return { exitCode: null, reason: null };
  }

  const container = containers[0];
  return {
    exitCode: container.exitCode,
    reason: container.reason || null,
    name: container.name,
    lastStatus: container.lastStatus,
  };
};

/**
 * Determine if task completed successfully
 * @param {Object} detail - ECS task state change detail
 * @returns {boolean} - True if task succeeded
 */
const isTaskSuccessful = (detail) => {
  const containers = detail.containers || [];
  if (containers.length === 0) {
    return false;
  }

  // Task is successful if all containers exited with code 0
  return containers.every(container => container.exitCode === 0);
};

/**
 * Get queue URL for a challenge from DynamoDB
 * @param {string} challengeId - Challenge UUID
 * @returns {Promise<string|null>} - Queue URL or null if not found
 */
const getQueueUrl = async (challengeId) => {
  if (!config.challengeMappingTable) {
    console.warn('CHALLENGE_MAPPING_TABLE not configured, cannot retry');
    return null;
  }

  try {
    const command = new GetItemCommand({
      TableName: config.challengeMappingTable,
      Key: {
        challengeId: { S: challengeId },
      },
      ProjectionExpression: 'queueUrl',
    });
    const response = await dynamodb.send(command);

    if (!response.Item || !response.Item.queueUrl) {
      console.warn('No queue URL found for challenge %s', challengeId);
      return null;
    }

    return response.Item.queueUrl.S;
  } catch (error) {
    console.error('Error fetching queue URL for challenge %s:', challengeId, error);
    return null;
  }
};

/**
 * Send retry message to SQS
 * @param {Object} params - Retry parameters
 * @param {string} params.queueUrl - SQS queue URL
 * @param {string} params.challengeId - Challenge UUID
 * @param {string} params.submissionId - Submission UUID
 * @param {string} params.scorerType - Scorer type
 * @param {number} params.retryCount - Current retry count (will be incremented)
 * @returns {Promise<boolean>} - True if message sent successfully
 */
const sendRetryMessage = async ({ queueUrl, challengeId, submissionId, scorerType, retryCount }) => {
  const newRetryCount = retryCount + 1;

  if (newRetryCount >= config.maxRetries) {
    console.error('Max retries (%d) reached for submission %s, scorer %s. Not retrying.', config.maxRetries, submissionId, scorerType);
    return false;
  }

  try {
    const message = {
      payload: {
        challengeId,
        submissionId,
        scorerType,
      },
      retryInfo: {
        retryCount: newRetryCount,
        retriedAt: new Date().toISOString(),
        reason: 'ECS task failed',
      },
    };

    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageAttributes: {
        RetryCount: {
          DataType: 'Number',
          StringValue: String(newRetryCount),
        },
        ScorerType: {
          DataType: 'String',
          StringValue: scorerType,
        },
      },
    });

    await sqs.send(command);
    console.log('Sent retry message for submission %s, scorer %s (retry %d)', submissionId, scorerType, newRetryCount);
    return true;
  } catch (error) {
    console.error('Failed to send retry message for submission %s:', submissionId, error);
    return false;
  }
};

/**
 * Lambda handler for EventBridge ECS Task State Change events
 * @param {Object} event - EventBridge event
 * @returns {Promise<Object>} - Processing result
 */
exports.handler = async (event) => {
  console.log('Completion Lambda received event:', JSON.stringify(event, null, 2));

  try {
    // Extract event details
    const detail = event.detail || {};
    const taskArn = detail.taskArn;
    const clusterArn = detail.clusterArn;
    // lastStatus is always 'STOPPED' when this handler is invoked (per EventBridge filter)
    const stoppedReason = detail.stoppedReason || 'No reason provided';
    const stoppedAt = detail.stoppedAt;
    const startedAt = detail.startedAt;

    // Extract tags for correlation
    const tags = extractTags(detail.tags);
    const challengeId = tags.ChallengeId || 'unknown';
    const submissionId = tags.SubmissionId || 'unknown';
    const scorerType = tags.ScorerType || 'unknown';
    const retryCount = parseInt(tags.RetryCount || '0', 10);

    // Extract container exit information
    const containerInfo = extractContainerInfo(detail.containers);

    // Determine success/failure
    const success = isTaskSuccessful(detail);

    // Calculate duration if possible
    let durationMs = null;
    if (startedAt && stoppedAt) {
      durationMs = new Date(stoppedAt).getTime() - new Date(startedAt).getTime();
    }

    // Build completion log entry
    const completionLog = {
      timestamp: new Date().toISOString(),
      taskArn,
      clusterArn,
      status: success ? 'SUCCESS' : 'FAILURE',
      challengeId,
      submissionId,
      scorerType,
      retryCount,
      exitCode: containerInfo.exitCode,
      stoppedReason,
      containerName: containerInfo.name,
      containerLastStatus: containerInfo.lastStatus,
      containerReason: containerInfo.reason,
      startedAt,
      stoppedAt,
      durationMs,
    };

    // Log completion status
    if (success) {
      console.log('TASK_SUCCESS:', JSON.stringify(completionLog, null, 2));
    } else {
      console.error('TASK_FAILURE:', JSON.stringify(completionLog, null, 2));

      // Attempt retry for failed tasks
      if (challengeId !== 'unknown' && submissionId !== 'unknown') {
        const queueUrl = await getQueueUrl(challengeId);
        if (queueUrl) {
          const retryQueued = await sendRetryMessage({
            queueUrl,
            challengeId,
            submissionId,
            scorerType,
            retryCount,
          });
          if (retryQueued) {
            console.log('Retry queued for failed task: submission %s, scorer %s', submissionId, scorerType);
          } else {
            console.error('Failed to queue retry for submission %s, scorer %s', submissionId, scorerType);
          }
        } else {
          console.error('Cannot retry: no queue URL available for challenge %s', challengeId);
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Task completion processed',
        taskArn,
        success,
        challengeId,
        submissionId,
        scorerType,
        retryQueued: !success && retryCount < config.maxRetries - 1,
      }),
    };
  } catch (error) {
    console.error('Error processing task completion event:', error);

    // Don't throw - we don't want EventBridge to retry for processing errors
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error processing task completion',
        error: error.message,
      }),
    };
  }
};
