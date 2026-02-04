/**
 * Unit tests for Submission Watcher Lambda
 * Tests: Cold-start caching, ECS task launch with tags, retry count handling
 */

const { mockClient } = require('aws-sdk-client-mock');
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

// Mock axios
jest.mock('axios');
const axios = require('axios');

// Mock AWS clients
const ecsMock = mockClient(ECSClient);
const ssmMock = mockClient(SSMClient);

// Set environment variables before requiring the handler
process.env.CHALLENGE_ID = '22222222-2222-2222-2222-222222222222';
process.env.ECS_CLUSTER = 'test-cluster';
process.env.ECS_TASK_DEFINITION = 'test-task-def';
process.env.ECS_SUBNETS = 'subnet-1,subnet-2';
process.env.ECS_SECURITY_GROUPS = 'sg-1';
process.env.ECS_CONTAINER_NAME = 'scorer-container';
process.env.AUTH0_URL = 'https://test.auth0.com/oauth/token';
process.env.AUTH0_AUDIENCE = 'https://test.api.com';
process.env.AUTH0_CLIENT_ID = 'test-client-id';
process.env.AUTH0_CLIENT_SECRET = 'test-client-secret';
process.env.AUTH0_PROXY_URL = 'https://auth0proxy.test.com/token';
process.env.MAX_RETRIES = '3';

// Clear module cache to reload with new env vars
jest.resetModules();

describe('Submission Watcher Lambda', () => {
  let handler;

  beforeEach(() => {
    ecsMock.reset();
    ssmMock.reset();
    jest.clearAllMocks();

    // Reset module cache for each test
    jest.resetModules();

    // Re-set environment variables
    process.env.CHALLENGE_ID = '22222222-2222-2222-2222-222222222222';
    process.env.MAX_RETRIES = '3';

    // Mock SSM responses
    ssmMock.on(GetParameterCommand).callsFake((input) => {
      if (input.Name.includes('/config')) {
        return {
          Parameter: {
            Value: JSON.stringify({
              name: 'Test Challenge',
              scorers: ['example', 'provisional'],
              submissionApiUrl: 'https://api.test.com',
            }),
          },
        };
      }
      if (input.Name.includes('/scorers/')) {
        return {
          Parameter: {
            Value: JSON.stringify({
              name: 'example',
              testerClass: 'com.test.Tester',
              timeLimit: 30000,
            }),
          },
        };
      }
      throw new Error(`Unknown parameter: ${input.Name}`);
    });

    // Mock axios for Auth0
    axios.post.mockResolvedValue({
      data: {
        access_token: 'test-access-token',
        expires_in: 86400,
      },
    });

    // Mock ECS RunTask
    ecsMock.on(RunTaskCommand).resolves({
      tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/test-task-id' }],
    });

    // Require handler after mocks are set up
    handler = require('./index').handler;
  });

  // Helper to create SQS event
  const createSqsEvent = (payload, messageAttributes = {}) => ({
    Records: [
      {
        messageId: 'test-message-id-1',
        body: JSON.stringify(payload),
        messageAttributes,
      },
    ],
  });

  describe('Cold-Start Configuration Caching', () => {
    test('should load challenge config from SSM on first call', async () => {
      const event = createSqsEvent({
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      });

      await handler(event);

      // Verify SSM was called for challenge config
      const ssmCalls = ssmMock.commandCalls(GetParameterCommand);
      const configCalls = ssmCalls.filter(call =>
        call.args[0].input.Name.includes('/config')
      );
      expect(configCalls.length).toBeGreaterThan(0);
    });

    test('should cache Auth0 token', async () => {
      const event = createSqsEvent({
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      });

      // First call
      await handler(event);
      const firstCallCount = axios.post.mock.calls.length;

      // Second call - should use cached token
      await handler(event);
      const secondCallCount = axios.post.mock.calls.length;

      // Token should be cached, so only one Auth0 call
      expect(secondCallCount).toBe(firstCallCount);
    });
  });

  describe('ECS Task Launch', () => {
    test('should launch ECS task with correct tags', async () => {
      const event = createSqsEvent({
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      });

      await handler(event);

      const ecsCalls = ecsMock.commandCalls(RunTaskCommand);
      expect(ecsCalls.length).toBeGreaterThan(0);

      const ecsInput = ecsCalls[0].args[0].input;

      // Verify tags
      expect(ecsInput.tags).toContainEqual({ key: 'ChallengeId', value: '22222222-2222-2222-2222-222222222222' });
      expect(ecsInput.tags).toContainEqual({ key: 'SubmissionId', value: '11111111-1111-1111-1111-111111111111' });
      expect(ecsInput.tags).toContainEqual({ key: 'RetryCount', value: '0' });
    });

    test('should launch task with correct environment variables', async () => {
      const event = createSqsEvent({
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      });

      await handler(event);

      const ecsCalls = ecsMock.commandCalls(RunTaskCommand);
      const containerOverrides = ecsCalls[0].args[0].input.overrides.containerOverrides[0];

      const envVars = containerOverrides.environment.reduce((acc, env) => {
        acc[env.name] = env.value;
        return acc;
      }, {});

      expect(envVars.CHALLENGE_ID).toBe('22222222-2222-2222-2222-222222222222');
      expect(envVars.SUBMISSION_ID).toBe('11111111-1111-1111-1111-111111111111');
      expect(envVars.ACCESS_TOKEN).toBe('test-access-token');
    });

    test('should launch tasks for all configured scorers', async () => {
      const event = createSqsEvent({
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      });

      await handler(event);

      // Should launch 2 tasks (example and provisional scorers)
      const ecsCalls = ecsMock.commandCalls(RunTaskCommand);
      expect(ecsCalls.length).toBe(2);
    });
  });

  describe('Retry Count Handling', () => {
    test('should extract retry count from message attributes', async () => {
      const event = createSqsEvent(
        {
          payload: {
            submissionId: '11111111-1111-1111-1111-111111111111',
            challengeId: '22222222-2222-2222-2222-222222222222',
          },
        },
        {
          RetryCount: { stringValue: '2', dataType: 'Number' },
        }
      );

      await handler(event);

      const ecsCalls = ecsMock.commandCalls(RunTaskCommand);
      const tags = ecsCalls[0].args[0].input.tags;
      expect(tags).toContainEqual({ key: 'RetryCount', value: '2' });
    });

    test('should skip processing when max retries exceeded', async () => {
      const event = createSqsEvent(
        {
          payload: {
            submissionId: '11111111-1111-1111-1111-111111111111',
            challengeId: '22222222-2222-2222-2222-222222222222',
          },
        },
        {
          RetryCount: { stringValue: '3', dataType: 'Number' },
        }
      );

      const result = await handler(event);

      // Should succeed but not launch any tasks
      expect(result.batchItemFailures).toHaveLength(0);
      expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0);
    });
  });

  describe('Challenge Mismatch Handling', () => {
    test('should skip messages for different challenges', async () => {
      const event = createSqsEvent({
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '99999999-9999-9999-9999-999999999999', // Different challenge
        },
      });

      const result = await handler(event);

      // Should succeed but not launch any tasks
      expect(result.batchItemFailures).toHaveLength(0);
      expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0);
    });
  });

  describe('Error Handling', () => {
    test('should report batch item failure when ECS fails', async () => {
      ecsMock.on(RunTaskCommand).rejects(new Error('ECS error'));

      const event = createSqsEvent({
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      });

      const result = await handler(event);

      expect(result.batchItemFailures).toHaveLength(1);
      expect(result.batchItemFailures[0].itemIdentifier).toBe('test-message-id-1');
    });
  });
});
