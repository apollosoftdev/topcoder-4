// Challenge configuration for fan-out architecture
export interface ChallengeConfig {
  challengeId: string;
  challengeName: string;
}

// Interface for the configuration structure
export interface AppConfig {
  submissionApiUrl: string;
  reviewScorecardId: string;
  reviewTypeName: string;
  logLevel: string;
  mskClusterName: string;
  ecsClusterName: string;
  logGroupName: string;
  taskTimeoutSeconds: string;
  maxRetries: string;
  // Auth0 M2M configuration
  auth0Url: string;
  auth0Audience: string;
  auth0ClientId: string;
  auth0ClientSecret: string;
  auth0ProxyUrl: string;
  // Existing infrastructure (optional)
  existingMskClusterArn?: string;
  existingMskSecurityGroupId?: string; // Security group ID for existing MSK cluster
  existingVpcId?: string;
  existingPrivateSubnetIds?: string; // Comma-separated subnet IDs
  existingSecurityGroupIds?: string; // Comma-separated security group IDs
  existingLambdaRoleArn?: string;    // Existing Lambda execution role ARN
  // ECS IAM Role ARNs (manually created)
  ecsTaskExecutionRoleArn: string;
  ecsTaskRoleArn: string;
  // Dev configuration
  devChallengeId: string;            // UUID format expected
  // Fan-out architecture configuration
  snsTopicName: string;
  challengeMappingTableName: string;
  ecsTaskStateRuleName: string;
  sqsVisibilityTimeoutSeconds: string;
  sqsMessageRetentionDays: string;
  sqsMaxReceiveCount: string;
  dlqRetentionDays: string;
  challenges: ChallengeConfig[];
}

// Function to load configuration from environment variables and file
function loadConfig(): AppConfig {
  // Parse challenges from environment variable (JSON array)
  let challenges: ChallengeConfig[] = [];
  if (process.env.CHALLENGES) {
    try {
      challenges = JSON.parse(process.env.CHALLENGES);
    } catch (e) {
      console.error('Failed to parse CHALLENGES environment variable:', e);
    }
  }

  // Default challenge config for dev
  const devChallengeId = process.env.DEV_CHALLENGE_ID || '00000000-0000-0000-0000-000000000000';
  if (challenges.length === 0) {
    challenges = [
      { challengeId: devChallengeId, challengeName: 'BioSlime' },
    ];
  }

  return {
    submissionApiUrl: process.env.SUBMISSION_API_URL || 'https://api.topcoder-dev.com/v5',
    reviewScorecardId: process.env.REVIEW_SCORECARD_ID || '30001852',
    reviewTypeName: process.env.REVIEW_TYPE_NAME || 'MMScorer',
    logLevel: process.env.LOG_LEVEL || 'debug',
    mskClusterName: process.env.MSK_CLUSTER_NAME || 'match-scorer',
    ecsClusterName: process.env.ECS_CLUSTER_NAME || 'match-scorer-ecs-cluster',
    logGroupName: process.env.LOG_GROUP_NAME || '/ecs/match-scorer',
    taskTimeoutSeconds: process.env.TASK_TIMEOUT_SECONDS || '60',
    maxRetries: process.env.MAX_RETRIES || '3',
    // Auth0 M2M defaults (can be overridden via env vars)
    auth0Url: process.env.AUTH0_URL || 'https://topcoder-dev.auth0.com/oauth/token',
    auth0Audience: process.env.AUTH0_AUDIENCE || 'https://m2m.topcoder-dev.com/',
    auth0ClientId: process.env.AUTH0_CLIENT_ID || '',
    auth0ClientSecret: process.env.AUTH0_CLIENT_SECRET || '',
    auth0ProxyUrl: process.env.AUTH0_PROXY_URL || 'https://auth0proxy.topcoder-dev.com/token',
    // Existing infrastructure (optional)
    existingMskClusterArn: process.env.EXISTING_MSK_CLUSTER_ARN || '',
    existingMskSecurityGroupId: process.env.EXISTING_MSK_SECURITY_GROUP_ID || '',
    existingVpcId: process.env.EXISTING_VPC_ID || '',
    existingPrivateSubnetIds: process.env.EXISTING_PRIVATE_SUBNET_IDS || '',
    existingSecurityGroupIds: process.env.EXISTING_SECURITY_GROUP_IDS || '',
    existingLambdaRoleArn: process.env.EXISTING_LAMBDA_ROLE_ARN || '',
    // ECS IAM Role ARNs (must be provided via environment variables)
    ecsTaskExecutionRoleArn: process.env.ECS_TASK_EXECUTION_ROLE_ARN || '',
    ecsTaskRoleArn: process.env.ECS_TASK_ROLE_ARN || '',
    // Dev configuration
    devChallengeId: devChallengeId,
    // Fan-out architecture configuration
    snsTopicName: process.env.SNS_TOPIC_NAME || 'submission-fanout-topic',
    challengeMappingTableName: process.env.CHALLENGE_MAPPING_TABLE_NAME || 'challenge-queue-mapping',
    ecsTaskStateRuleName: process.env.ECS_TASK_STATE_RULE_NAME || 'ecs-task-state-change-rule',
    sqsVisibilityTimeoutSeconds: process.env.SQS_VISIBILITY_TIMEOUT_SECONDS || '120',
    sqsMessageRetentionDays: process.env.SQS_MESSAGE_RETENTION_DAYS || '7',
    sqsMaxReceiveCount: process.env.SQS_MAX_RECEIVE_COUNT || '3',
    dlqRetentionDays: process.env.DLQ_RETENTION_DAYS || '14',
    challenges: challenges,
  };
}

// Export the loaded configuration
export const config: AppConfig = loadConfig();
export const devScorers = [
  {
    name: 'BioSlime',
    testerClass: 'com.topcoder.challenges.mm160.BioSlimeTester',
    timeLimit: 10000,
    timeout: 10000,
    compileTimeout: 10000,
    startSeed: 42,
    numberOfTests: 1,
    phases: [
      {
        name: 'example',
        reviewTypeId: '70a39434-ff40-430c-bbe0-b00882e7f92e',
        scoreCardId: '30001852'
      },
      {
        name: 'provisional',
        reviewTypeId: '2ef9953d-49e9-47fc-842e-c2b9b18a9e3b',
        scoreCardId: '30001852'
      }
    ]
  }
];
 