const { ECSClient, RunTaskCommand, DescribeTasksCommand, StopTaskCommand } = require('@aws-sdk/client-ecs');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const axios = require('axios');
const ecs = new ECSClient();
const ssm = new SSMClient();

// Configuration from environment variables
const config = {
  cluster: process.env.ECS_CLUSTER,
  taskDefinition: process.env.ECS_TASK_DEFINITION,
  subnets: process.env.ECS_SUBNETS.split(','),
  securityGroups: [process.env.ECS_SECURITY_GROUPS],
  containerName: process.env.ECS_CONTAINER_NAME,
  taskTimeoutSeconds: parseInt(process.env.TASK_TIMEOUT_SECONDS || '60'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
};

/**
 * Wait for a specified time
 * @param {number} ms - Time to wait in milliseconds
 * @returns {Promise} - Promise that resolves after the specified time
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Check if a task is still running
 * @param {string} taskArn - ARN of the task to check
 * @returns {Promise<boolean>} - Promise that resolves to true if task is still running
 */
const isTaskRunning = async (taskArn) => {
  try {
    const command = new DescribeTasksCommand({
      cluster: config.cluster,
      tasks: [taskArn]
    });
    const { tasks } = await ecs.send(command);

    if (!tasks || tasks.length === 0) {
      return false;
    }

    const task = tasks[0];
    return task.lastStatus === 'RUNNING';
  } catch (error) {
    console.error('Error checking task status:', error);
    return false;
  }
};

async function getChallengeConfig(challengeId) {
  const paramName = `/scorer/challenges/${challengeId}/config`;
  const command = new GetParameterCommand({ Name: paramName });
  const response = await ssm.send(command);
  return JSON.parse(response.Parameter.Value);
}

const getScorerConfig = async (challengeId, scorerType) => {
  const paramName = `/scorer/challenges/${challengeId}/scorers/${scorerType}/config`;
  const command = new GetParameterCommand({ Name: paramName });
  const response = await ssm.send(command);
  return JSON.parse(response.Parameter.Value);
};

const getAccessToken = async () => {
  const {
    AUTH0_URL,
    AUTH0_AUDIENCE,
    AUTH0_CLIENT_ID,
    AUTH0_CLIENT_SECRET,
    AUTH0_PROXY_URL,
  } = process.env;
  if (!AUTH0_URL || !AUTH0_AUDIENCE || !AUTH0_CLIENT_ID || !AUTH0_CLIENT_SECRET || !AUTH0_PROXY_URL) {
    throw new Error('Missing required Auth0 M2M configuration (AUTH0_URL, AUTH0_AUDIENCE, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_PROXY_URL)');
  }
  const payload = {
    grant_type: 'client_credentials',
    client_id: AUTH0_CLIENT_ID,
    client_secret: AUTH0_CLIENT_SECRET,
    audience: AUTH0_AUDIENCE,
    auth0_url: AUTH0_URL,
  };
  const response = await axios.post(AUTH0_PROXY_URL, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  if (!response.data || !response.data.access_token) {
    throw new Error('Auth0 proxy response did not include access_token');
  }
  return response.data.access_token;
};

const runScorerTask = async ({ challengeId, scorerType, submissionId }) => {
  const challengeConfig = await getChallengeConfig(challengeId);
  const scorerConfig = await getScorerConfig(challengeId, scorerType);
  const accessToken = await getAccessToken();
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
    overrides: {
      containerOverrides: [
        {
          name: config.containerName,
          environment: [
            { name: 'CHALLENGE_ID', value: String(challengeId) },
            { name: 'SCORER_TYPE', value: String(scorerType) },
            { name: 'SUBMISSION_ID', value: String(submissionId) },
            { name: 'CHALLENGE_CONFIG', value: JSON.stringify(challengeConfig) },
            { name: 'SCORER_CONFIG', value: JSON.stringify(scorerConfig) },
            { name: 'ACCESS_TOKEN', value: String(accessToken) },
          ],
        },
      ],
    },
  });
  const { tasks } = await ecs.send(command);
  if (!tasks || tasks.length === 0) throw new Error('Failed to start ECS task');
  return tasks[0].taskArn;
};

async function updateSubmissionStatus(submissionId, status, accessToken, submissionApiUrl) {
  try {
    const url = `${submissionApiUrl}/submissions/${submissionId}`;
    const response = await axios.patch(
      url,
      { submissionPhase: status },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`Updated submission ${submissionId} status to ${status}: HTTP ${response.status}`);
  } catch (error) {
    console.error('Failed to update submission %s status to %s:', submissionId, status, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Process a Kafka message
 * @param {Object} event - Lambda event containing Kafka message
 * @returns {Promise<Object>} - Promise that resolves to the processing result
 */
exports.handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  const promises = [];
  for (const topicPartitionKey in event.records) {
    if (Object.hasOwnProperty.call(event.records, topicPartitionKey)) {
      const records = event.records[topicPartitionKey];
      for (const record of records) {
        try {
          const decodedValue = Buffer.from(record.value, 'base64').toString('utf-8');
          const message = JSON.parse(decodedValue);
          const submissionId = message?.payload?.submissionId;
          const challengeId = message?.payload?.challengeId;
          if (!submissionId || !challengeId) {
            console.error('Missing submissionId or challengeId in message payload:', message);
            continue;
          }
          // Fetch challenge config from Parameter Store
          const challengeConfig = await getChallengeConfig(challengeId);
          if (!challengeConfig.scorers || !Array.isArray(challengeConfig.scorers)) {
            console.error('No scorers configured for challenge:', challengeId);
            continue;
          }
          // Confirmed to ignore updating status in forum. This method needs to be updated when it's clarified how implementation will look like.
          console.log(`(MOCK) Setting submission status to 'submitted' for ${submissionId}`);
          for (const scorerType of challengeConfig.scorers) {
            promises.push(runScorerTask({ challengeId, scorerType, submissionId }));
          }
        } catch (processingError) {
          console.error('Error processing individual record:', processingError, 'Record:', record);
        }
      }
    }
  }
  const results = await Promise.allSettled(promises);
  const failedTasks = results.filter(result => result.status === 'rejected');
  if (failedTasks.length > 0) {
    failedTasks.forEach((result, idx) => {
      console.error('Scorer task %d failed:', idx, result.reason);
    });
    console.error('All failed task results:', JSON.stringify(failedTasks, null, 2));
    throw new Error(`${failedTasks.length} out of ${promises.length} scorer tasks failed.`);
  }
  return { status: 'Batch processed successfully' };
}; 