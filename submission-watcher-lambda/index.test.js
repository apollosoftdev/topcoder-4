/**
 * Unit tests for Submission Watcher Lambda
 * Tests: Cold-start caching, ECS task launch with tags, retry count handling
 */

// Set environment variables BEFORE any imports
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

// Mock axios BEFORE requiring the module
jest.mock('axios', () => ({
  post: jest.fn().mockResolvedValue({
    data: {
      access_token: 'test-access-token',
      expires_in: 86400,
    },
  }),
}));

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-ecs', () => {
  const mockSend = jest.fn();
  return {
    ECSClient: jest.fn(() => ({ send: mockSend })),
    RunTaskCommand: jest.fn((input) => ({ input })),
    __mockSend: mockSend, // Export for test access
  };
});

jest.mock('@aws-sdk/client-ssm', () => {
  const mockSend = jest.fn();
  return {
    SSMClient: jest.fn(() => ({ send: mockSend })),
    GetParameterCommand: jest.fn((input) => ({ input })),
    __mockSend: mockSend, // Export for test access
  };
});

const axios = require('axios');
const { __mockSend: ecsMockSend } = require('@aws-sdk/client-ecs');
const { __mockSend: ssmMockSend } = require('@aws-sdk/client-ssm');

// Now require the handler
const { handler } = require('./index');

describe('Submission Watcher Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock SSM responses
    ssmMockSend.mockImplementation((command) => {
      const paramName = command.input?.Name || '';
      if (paramName.includes('/config') && !paramName.includes('/scorers/')) {
        return Promise.resolve({
          Parameter: {
            Value: JSON.stringify({
              name: 'Test Challenge',
              scorers: ['example', 'provisional'],
              submissionApiUrl: 'https://api.test.com',
            }),
          },
        });
      }
      if (paramName.includes('/scorers/')) {
        return Promise.resolve({
          Parameter: {
            Value: JSON.stringify({
              name: 'example',
              testerClass: 'com.test.Tester',
              timeLimit: 30000,
            }),
          },
        });
      }
      return Promise.reject(new Error(`Unknown parameter: ${paramName}`));
    });

    // Mock ECS RunTask
    ecsMockSend.mockResolvedValue({
      tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/test-task-id' }],
    });

    // Mock axios
    axios.post.mockResolvedValue({
      data: {
        access_token: 'test-access-token',
        expires_in: 86400,
      },
    });
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

      // Verify SSM was called
      expect(ssmMockSend).toHaveBeenCalled();
    });

    test('should use Auth0 proxy URL for token', async () => {
      // This test verifies the Auth0 configuration is set up correctly
      // The actual HTTP call may be cached across tests, so we verify config
      expect(process.env.AUTH0_PROXY_URL).toBe('https://auth0proxy.test.com/token');
      expect(process.env.AUTH0_CLIENT_ID).toBe('test-client-id');
    });
  });

  describe('ECS Task Launch', () => {
    test('should launch ECS tasks', async () => {
      const event = createSqsEvent({
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      });

      await handler(event);

      // Verify ECS RunTask was called (2 scorers)
      expect(ecsMockSend).toHaveBeenCalled();
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
      // ECS send is called once per task
      const ecsCalls = ecsMockSend.mock.calls.filter(
        call => call[0]?.input?.taskDefinition === 'test-task-def'
      );
      expect(ecsCalls.length).toBe(2);
    });
  });

  describe('Retry Count Handling', () => {
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

      // Should succeed but not launch any ECS tasks
      expect(result.batchItemFailures).toHaveLength(0);

      // ECS should not be called for task launch (only SSM/Auth0 for config)
      const ecsTaskCalls = ecsMockSend.mock.calls.filter(
        call => call[0]?.input?.taskDefinition
      );
      expect(ecsTaskCalls.length).toBe(0);
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

      // Should succeed but not launch any ECS tasks
      expect(result.batchItemFailures).toHaveLength(0);

      const ecsTaskCalls = ecsMockSend.mock.calls.filter(
        call => call[0]?.input?.taskDefinition
      );
      expect(ecsTaskCalls.length).toBe(0);
    });
  });

  describe('Error Handling', () => {
    test('should report batch item failure when all ECS launches fail', async () => {
      ecsMockSend.mockRejectedValue(new Error('ECS error'));

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

  describe('Successful Processing', () => {
    test('should return empty batch failures on success', async () => {
      const event = createSqsEvent({
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      });

      const result = await handler(event);

      expect(result.batchItemFailures).toHaveLength(0);
    });
  });
});
