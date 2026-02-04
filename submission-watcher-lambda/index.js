const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const axios = require('axios');

const ecs = new ECSClient();
const ssm = new SSMClient();

// Configuration from environment variables
const config = {
  challengeId: process.env.CHALLENGE_ID,
  cluster: process.env.ECS_CLUSTER,
  taskDefinition: process.env.ECS_TASK_DEFINITION,
  subnets: process.env.ECS_SUBNETS?.split(',') || [],
  securityGroups: process.env.ECS_SECURITY_GROUPS?.split(',') || [],
  containerName: process.env.ECS_CONTAINER_NAME,
  auth0Url: process.env.AUTH0_URL,
  auth0Audience: process.env.AUTH0_AUDIENCE,
  auth0ClientId: process.env.AUTH0_CLIENT_ID,
  auth0ClientSecret: process.env.AUTH0_CLIENT_SECRET,
  auth0ProxyUrl: process.env.AUTH0_PROXY_URL,
  maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
};

// Cold-start configuration cache
let challengeConfigCache = null;
let scorerConfigsCache = {};
let tokenCache = null;
let tokenExpiry = null;

// Token expiry buffer (5 minutes before actual expiry)
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Load challenge config from SSM Parameter Store (cold-start optimization)
 * @returns {Promise<Object>} - Challenge configuration
 */
const loadChallengeConfig = async () => {
  if (challengeConfigCache) {
    return challengeConfigCache;
  }

  const paramName = `/scorer/challenges/${config.challengeId}/config`;
  console.log('Loading challenge config from SSM: %s', paramName);

  const command = new GetParameterCommand({ Name: paramName });
  const response = await ssm.send(command);
  challengeConfigCache = JSON.parse(response.Parameter.Value);

  console.log('Loaded challenge config for %s', config.challengeId);
  return challengeConfigCache;
};

/**
 * Load scorer config from SSM Parameter Store (cold-start optimization)
 * @param {string} scorerType - Scorer type name
 * @returns {Promise<Object>} - Scorer configuration
 */
const loadScorerConfig = async (scorerType) => {
  if (scorerConfigsCache[scorerType]) {
    return scorerConfigsCache[scorerType];
  }

  const paramName = `/scorer/challenges/${config.challengeId}/scorers/${scorerType}/config`;
  console.log('Loading scorer config from SSM: %s', paramName);

  const command = new GetParameterCommand({ Name: paramName });
  const response = await ssm.send(command);
  scorerConfigsCache[scorerType] = JSON.parse(response.Parameter.Value);

  console.log('Loaded scorer config for %s', scorerType);
  return scorerConfigsCache[scorerType];
};

/**
 * Get Auth0 access token with caching
 * @returns {Promise<string>} - Access token
 */
const getAccessToken = async () => {
  // Check if we have a valid cached token
  if (tokenCache && tokenExpiry && Date.now() < tokenExpiry - TOKEN_EXPIRY_BUFFER_MS) {
    console.log('Using cached access token');
    return tokenCache;
  }

  console.log('Fetching new access token from Auth0');

  if (!config.auth0Url || !config.auth0Audience || !config.auth0ClientId || !config.auth0ClientSecret || !config.auth0ProxyUrl) {
    throw new Error('Missing required Auth0 M2M configuration');
  }

  const payload = {
    grant_type: 'client_credentials',
    client_id: config.auth0ClientId,
    client_secret: config.auth0ClientSecret,
    audience: config.auth0Audience,
    auth0_url: config.auth0Url,
  };

  const response = await axios.post(config.auth0ProxyUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });

  if (!response.data || !response.data.access_token) {
    throw new Error('Auth0 proxy response did not include access_token');
  }

  // Cache the token with expiry (default 24 hours if not specified)
  tokenCache = response.data.access_token;
  const expiresIn = response.data.expires_in || 86400;
  tokenExpiry = Date.now() + (expiresIn * 1000);

  console.log('Access token cached, expires in %d seconds', expiresIn);
  return tokenCache;
};

/**
 * Launch ECS task for scoring (fire-and-forget)
 * @param {Object} params - Task parameters
 * @param {string} params.submissionId - Submission UUID
 * @param {string} params.scorerType - Scorer type name
 * @param {Object} params.challengeConfig - Challenge configuration
 * @param {Object} params.scorerConfig - Scorer configuration
 * @param {string} params.accessToken - Auth0 access token
 * @param {number} params.retryCount - Current retry count
 * @returns {Promise<string>} - Task ARN
 */
const launchEcsTask = async ({ submissionId, scorerType, challengeConfig, scorerConfig, accessToken, retryCount = 0 }) => {
  const command = new RunTaskCommand({
    cluster: config.cluster,
    taskDefinition: config.taskDefinition,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: config.subnets,
        securityGroups: config.securityGroups,
        assignPublicIp: 'DISABLED',
      },
    },
    // Tag the task for EventBridge correlation
    tags: [
      { key: 'ChallengeId', value: config.challengeId },
      { key: 'SubmissionId', value: submissionId },
      { key: 'ScorerType', value: scorerType },
      { key: 'RetryCount', value: String(retryCount) },
    ],
    overrides: {
      containerOverrides: [
        {
          name: config.containerName,
          environment: [
            { name: 'CHALLENGE_ID', value: config.challengeId },
            { name: 'SCORER_TYPE', value: scorerType },
            { name: 'SUBMISSION_ID', value: submissionId },
            { name: 'CHALLENGE_CONFIG', value: JSON.stringify(challengeConfig) },
            { name: 'SCORER_CONFIG', value: JSON.stringify(scorerConfig) },
            { name: 'ACCESS_TOKEN', value: accessToken },
          ],
        },
      ],
    },
  });

  const response = await ecs.send(command);

  if (!response.tasks || response.tasks.length === 0) {
    throw new Error('Failed to start ECS task');
  }

  const taskArn = response.tasks[0].taskArn;
  console.log('Launched ECS task %s for submission %s, scorer %s (retry: %d)', taskArn, submissionId, scorerType, retryCount);
  return taskArn;
};

/**
 * Extract retry count from message attributes
 * @param {Object} record - SQS record
 * @returns {number} - Retry count
 */
const getRetryCount = (record) => {
  try {
    const attributes = record.messageAttributes || {};
    if (attributes.RetryCount && attributes.RetryCount.stringValue) {
      return parseInt(attributes.RetryCount.stringValue, 10);
    }
  } catch (e) {
    // Ignore parsing errors
  }
  return 0;
};

/**
 * Process a single SQS message
 * @param {Object} record - SQS record
 * @returns {Promise<{success: boolean, messageId: string}>} - Processing result
 */
const processRecord = async (record) => {
  const messageId = record.messageId;

  try {
    // Parse message body (raw message from SNS with rawMessageDelivery)
    const message = JSON.parse(record.body);
    const submissionId = message?.payload?.submissionId;
    const challengeId = message?.payload?.challengeId;
    const retryCount = getRetryCount(record);

    console.log('Processing submission %s for challenge %s (retry: %d)', submissionId, challengeId, retryCount);

    // Verify this message is for our challenge
    if (challengeId !== config.challengeId) {
      console.warn('Message challenge %s does not match configured challenge %s', challengeId, config.challengeId);
      return { success: true, messageId }; // Skip misrouted messages
    }

    // Check max retries
    if (retryCount >= config.maxRetries) {
      console.error('Max retries (%d) exceeded for submission %s', config.maxRetries, submissionId);
      return { success: true, messageId }; // Don't retry further, let DLQ handle
    }

    // Load configurations (cached after cold start)
    const challengeConfig = await loadChallengeConfig();
    const accessToken = await getAccessToken();

    // Get configured scorers for this challenge
    const scorers = challengeConfig.scorers || [];
    if (scorers.length === 0) {
      console.error('No scorers configured for this challenge');
      return { success: true, messageId };
    }

    // Launch ECS tasks for each scorer (fire-and-forget)
    const taskPromises = [];
    for (const scorerType of scorers) {
      const scorerConfig = await loadScorerConfig(scorerType);
      taskPromises.push(
        launchEcsTask({
          submissionId,
          scorerType,
          challengeConfig,
          scorerConfig,
          accessToken,
          retryCount,
        })
      );
    }

    // Wait for all task launches (but not task completion)
    const results = await Promise.allSettled(taskPromises);

    // Log any launch failures
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.error('%d out of %d task launches failed', failures.length, taskPromises.length);
      failures.forEach((f, idx) => console.error('Task %d launch failed:', idx, f.reason));

      // If all launches failed, report failure
      if (failures.length === taskPromises.length) {
        return { success: false, messageId };
      }
    }

    console.log('Successfully launched %d ECS tasks for submission %s', taskPromises.length - failures.length, submissionId);
    return { success: true, messageId };
  } catch (error) {
    console.error('Error processing message %s:', messageId, error);
    return { success: false, messageId };
  }
};

/**
 * Lambda handler for SQS events
 * @param {Object} event - Lambda event containing SQS messages
 * @returns {Promise<Object>} - Response with batch item failures
 */
exports.handler = async (event) => {
  console.log('Submission Watcher Lambda (%s) received %d messages', config.challengeId, event.Records?.length || 0);

  // Pre-load configurations during cold start
  try {
    await loadChallengeConfig();
    await getAccessToken();
  } catch (error) {
    console.error('Error during cold-start configuration loading:', error);
    // Continue processing - individual records will fail if config is unavailable
  }

  const batchItemFailures = [];

  // Process all records
  for (const record of event.Records || []) {
    const result = await processRecord(record);
    if (!result.success) {
      batchItemFailures.push({
        itemIdentifier: result.messageId,
      });
    }
  }

  // Report partial batch failures
  if (batchItemFailures.length > 0) {
    console.log('Batch processing completed with %d failures', batchItemFailures.length);
    return { batchItemFailures };
  }

  console.log('Batch processing completed successfully');
  return { batchItemFailures: [] };
};

// Pre-load configurations at module load time (cold start)
// This runs when Lambda container starts, not on every invocation
(async () => {
  if (config.challengeId) {
    console.log('Cold start: Pre-loading configurations for challenge %s', config.challengeId);
    try {
      await loadChallengeConfig();
    } catch (error) {
      console.warn('Cold start config pre-load failed (will retry on first invocation):', error.message);
    }
  }
})();
