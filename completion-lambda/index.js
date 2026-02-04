/**
 * Completion Lambda
 * Triggered by EventBridge when ECS tasks stop
 * Logs task completion status and extracts correlation tags
 */

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
    const lastStatus = detail.lastStatus;
    const stoppedReason = detail.stoppedReason || 'No reason provided';
    const stoppedAt = detail.stoppedAt;
    const startedAt = detail.startedAt;

    // Extract tags for correlation
    const tags = extractTags(detail.tags);
    const challengeId = tags.ChallengeId || 'unknown';
    const submissionId = tags.SubmissionId || 'unknown';
    const scorerType = tags.ScorerType || 'unknown';

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
    }

    // Future: Update submission status via API
    // This would involve:
    // 1. Getting an access token (similar to challenge-processor-lambda)
    // 2. Calling the submission API to update status
    // 3. Creating a review record if scoring succeeded
    //
    // For now, we just log the completion status
    console.log(`(FUTURE) Would update submission ${submissionId} status based on task ${success ? 'success' : 'failure'}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Task completion processed',
        taskArn,
        success,
        challengeId,
        submissionId,
        scorerType,
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
