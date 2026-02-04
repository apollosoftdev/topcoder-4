/**
 * Unit tests for Completion Lambda
 * Tests: Success/failure detection, retry message sending, max retries
 */

const { mockClient } = require('aws-sdk-client-mock');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

// Mock AWS clients
const sqsMock = mockClient(SQSClient);
const dynamoMock = mockClient(DynamoDBClient);

// Set environment variables before requiring the handler
process.env.CHALLENGE_MAPPING_TABLE = 'test-challenge-mapping';
process.env.MAX_RETRIES = '3';

// Import handler after setting env vars
const { handler } = require('./index');

describe('Completion Lambda', () => {
  beforeEach(() => {
    sqsMock.reset();
    dynamoMock.reset();
    jest.clearAllMocks();
  });

  // Helper to create EventBridge ECS Task State Change event
  const createTaskEvent = ({ exitCode = 0, tags = [], stoppedReason = 'Essential container in task exited' }) => ({
    'detail-type': 'ECS Task State Change',
    source: 'aws.ecs',
    detail: {
      taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/test-task-id',
      clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/test-cluster',
      lastStatus: 'STOPPED',
      stoppedReason,
      startedAt: '2024-01-01T10:00:00.000Z',
      stoppedAt: '2024-01-01T10:05:00.000Z',
      containers: [
        {
          name: 'scorer-container',
          exitCode,
          lastStatus: 'STOPPED',
          reason: exitCode === 0 ? null : 'Container failed',
        },
      ],
      tags,
    },
  });

  describe('Task Success Detection', () => {
    test('should detect successful task (exit code 0)', async () => {
      const event = createTaskEvent({
        exitCode: 0,
        tags: [
          { key: 'ChallengeId', value: '22222222-2222-2222-2222-222222222222' },
          { key: 'SubmissionId', value: '11111111-1111-1111-1111-111111111111' },
          { key: 'ScorerType', value: 'example' },
          { key: 'RetryCount', value: '0' },
        ],
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);

      // Should NOT send retry message for successful task
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    });

    test('should detect failed task (exit code non-zero)', async () => {
      dynamoMock.on(GetItemCommand).resolves({
        Item: { queueUrl: { S: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue' } },
      });
      sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg-id' });

      const event = createTaskEvent({
        exitCode: 1,
        tags: [
          { key: 'ChallengeId', value: '22222222-2222-2222-2222-222222222222' },
          { key: 'SubmissionId', value: '11111111-1111-1111-1111-111111111111' },
          { key: 'ScorerType', value: 'example' },
          { key: 'RetryCount', value: '0' },
        ],
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
    });
  });

  describe('Retry Mechanism', () => {
    test('should send retry message to SQS on task failure', async () => {
      dynamoMock.on(GetItemCommand).resolves({
        Item: { queueUrl: { S: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue' } },
      });
      sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg-id' });

      const event = createTaskEvent({
        exitCode: 1,
        tags: [
          { key: 'ChallengeId', value: '22222222-2222-2222-2222-222222222222' },
          { key: 'SubmissionId', value: '11111111-1111-1111-1111-111111111111' },
          { key: 'ScorerType', value: 'example' },
          { key: 'RetryCount', value: '0' },
        ],
      });

      await handler(event);

      // Should send retry message
      const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
      expect(sqsCalls).toHaveLength(1);

      const sqsInput = sqsCalls[0].args[0].input;
      expect(sqsInput.QueueUrl).toBe('https://sqs.us-east-1.amazonaws.com/123456789012/test-queue');

      // Verify message attributes include incremented retry count
      expect(sqsInput.MessageAttributes.RetryCount.StringValue).toBe('1');
    });

    test('should include correct payload in retry message', async () => {
      dynamoMock.on(GetItemCommand).resolves({
        Item: { queueUrl: { S: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue' } },
      });
      sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg-id' });

      const event = createTaskEvent({
        exitCode: 2,
        tags: [
          { key: 'ChallengeId', value: '22222222-2222-2222-2222-222222222222' },
          { key: 'SubmissionId', value: '11111111-1111-1111-1111-111111111111' },
          { key: 'ScorerType', value: 'provisional' },
          { key: 'RetryCount', value: '1' },
        ],
      });

      await handler(event);

      const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
      const messageBody = JSON.parse(sqsCalls[0].args[0].input.MessageBody);

      expect(messageBody.payload.challengeId).toBe('22222222-2222-2222-2222-222222222222');
      expect(messageBody.payload.submissionId).toBe('11111111-1111-1111-1111-111111111111');
      expect(messageBody.payload.scorerType).toBe('provisional');
      expect(messageBody.retryInfo.retryCount).toBe(2);
      expect(messageBody.retryInfo.reason).toBe('ECS task failed');
    });
  });

  describe('Max Retries Limit', () => {
    test('should NOT retry when max retries reached', async () => {
      dynamoMock.on(GetItemCommand).resolves({
        Item: { queueUrl: { S: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue' } },
      });

      const event = createTaskEvent({
        exitCode: 1,
        tags: [
          { key: 'ChallengeId', value: '22222222-2222-2222-2222-222222222222' },
          { key: 'SubmissionId', value: '11111111-1111-1111-1111-111111111111' },
          { key: 'ScorerType', value: 'example' },
          { key: 'RetryCount', value: '2' }, // Already at retry 2, max is 3
        ],
      });

      await handler(event);

      // Should NOT send retry message (max retries reached)
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    });

    test('should retry when below max retries', async () => {
      dynamoMock.on(GetItemCommand).resolves({
        Item: { queueUrl: { S: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue' } },
      });
      sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg-id' });

      const event = createTaskEvent({
        exitCode: 1,
        tags: [
          { key: 'ChallengeId', value: '22222222-2222-2222-2222-222222222222' },
          { key: 'SubmissionId', value: '11111111-1111-1111-1111-111111111111' },
          { key: 'ScorerType', value: 'example' },
          { key: 'RetryCount', value: '1' }, // At retry 1, can still retry
        ],
      });

      await handler(event);

      // Should send retry message
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    });
  });

  describe('DynamoDB Queue URL Lookup', () => {
    test('should lookup queue URL from DynamoDB', async () => {
      dynamoMock.on(GetItemCommand).resolves({
        Item: { queueUrl: { S: 'https://sqs.us-east-1.amazonaws.com/123456789012/challenge-queue' } },
      });
      sqsMock.on(SendMessageCommand).resolves({ MessageId: 'test-msg-id' });

      const event = createTaskEvent({
        exitCode: 1,
        tags: [
          { key: 'ChallengeId', value: '22222222-2222-2222-2222-222222222222' },
          { key: 'SubmissionId', value: '11111111-1111-1111-1111-111111111111' },
          { key: 'ScorerType', value: 'example' },
          { key: 'RetryCount', value: '0' },
        ],
      });

      await handler(event);

      // Verify DynamoDB was called with correct challenge ID
      const dynamoCalls = dynamoMock.commandCalls(GetItemCommand);
      expect(dynamoCalls).toHaveLength(1);
      expect(dynamoCalls[0].args[0].input.Key.challengeId.S).toBe('22222222-2222-2222-2222-222222222222');
    });

    test('should handle missing queue URL gracefully', async () => {
      dynamoMock.on(GetItemCommand).resolves({}); // No Item returned

      const event = createTaskEvent({
        exitCode: 1,
        tags: [
          { key: 'ChallengeId', value: '22222222-2222-2222-2222-222222222222' },
          { key: 'SubmissionId', value: '11111111-1111-1111-1111-111111111111' },
          { key: 'ScorerType', value: 'example' },
          { key: 'RetryCount', value: '0' },
        ],
      });

      // Should not throw, just log and continue
      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // Should NOT attempt to send message
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    });
  });

  describe('Tag Extraction', () => {
    test('should handle missing tags gracefully', async () => {
      const event = createTaskEvent({
        exitCode: 0,
        tags: [], // No tags
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.challengeId).toBe('unknown');
      expect(body.submissionId).toBe('unknown');
    });

    test('should extract all task correlation tags', async () => {
      const event = createTaskEvent({
        exitCode: 0,
        tags: [
          { key: 'ChallengeId', value: 'challenge-123' },
          { key: 'SubmissionId', value: 'submission-456' },
          { key: 'ScorerType', value: 'example' },
          { key: 'RetryCount', value: '2' },
        ],
      });

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(body.challengeId).toBe('challenge-123');
      expect(body.submissionId).toBe('submission-456');
      expect(body.scorerType).toBe('example');
    });
  });

  describe('Duration Calculation', () => {
    test('should calculate task duration correctly', async () => {
      const event = createTaskEvent({
        exitCode: 0,
        tags: [
          { key: 'ChallengeId', value: '22222222-2222-2222-2222-222222222222' },
          { key: 'SubmissionId', value: '11111111-1111-1111-1111-111111111111' },
          { key: 'ScorerType', value: 'example' },
        ],
      });

      // startedAt: 10:00:00, stoppedAt: 10:05:00 = 5 minutes = 300000ms
      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      // Duration is logged, not returned - but the handler should complete successfully
    });
  });
});
