/**
 * Unit tests for Router Lambda
 * Tests: Kafka message decoding, DynamoDB lookup, SNS publishing, validation
 */

const { mockClient } = require('aws-sdk-client-mock');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

// Mock AWS clients
const snsMock = mockClient(SNSClient);
const dynamoMock = mockClient(DynamoDBClient);

// Set environment variables before requiring the handler
process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:test-topic';
process.env.CHALLENGE_MAPPING_TABLE = 'test-challenge-mapping';

// Import handler after setting env vars
const { handler } = require('./index');

describe('Router Lambda', () => {
  beforeEach(() => {
    snsMock.reset();
    dynamoMock.reset();
    jest.clearAllMocks();
  });

  // Helper to create Kafka event
  const createKafkaEvent = (payload) => {
    const message = JSON.stringify(payload);
    const base64Message = Buffer.from(message).toString('base64');
    return {
      records: {
        'submission.notification.create-0': [
          {
            topic: 'submission.notification.create',
            partition: 0,
            offset: 100,
            value: base64Message,
          },
        ],
      },
    };
  };

  describe('Kafka Message Decoding', () => {
    test('should decode base64 Kafka message correctly', async () => {
      const testPayload = {
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      };

      // Mock DynamoDB - challenge is active
      dynamoMock.on(GetItemCommand).resolves({
        Item: { active: { BOOL: true } },
      });

      // Mock SNS publish
      snsMock.on(PublishCommand).resolves({ MessageId: 'test-message-id' });

      const event = createKafkaEvent(testPayload);
      const result = await handler(event);

      expect(result.batchItemFailures).toHaveLength(0);

      // Verify SNS was called with correct message
      const snsCalls = snsMock.commandCalls(PublishCommand);
      expect(snsCalls).toHaveLength(1);

      const publishedMessage = JSON.parse(snsCalls[0].args[0].input.Message);
      expect(publishedMessage.payload.submissionId).toBe('11111111-1111-1111-1111-111111111111');
      expect(publishedMessage.payload.challengeId).toBe('22222222-2222-2222-2222-222222222222');
    });
  });

  describe('UUID Validation', () => {
    test('should reject invalid submissionId format', async () => {
      const testPayload = {
        payload: {
          submissionId: 'invalid-uuid',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      };

      const event = createKafkaEvent(testPayload);
      const result = await handler(event);

      // Should succeed (skip invalid) but not publish to SNS
      expect(result.batchItemFailures).toHaveLength(0);
      expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    });

    test('should reject invalid challengeId format', async () => {
      const testPayload = {
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: 'not-a-uuid',
        },
      };

      const event = createKafkaEvent(testPayload);
      const result = await handler(event);

      expect(result.batchItemFailures).toHaveLength(0);
      expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    });

    test('should reject missing submissionId', async () => {
      const testPayload = {
        payload: {
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      };

      const event = createKafkaEvent(testPayload);
      const result = await handler(event);

      expect(result.batchItemFailures).toHaveLength(0);
      expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    });
  });

  describe('DynamoDB Challenge Lookup', () => {
    test('should skip inactive challenges', async () => {
      const testPayload = {
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      };

      // Mock DynamoDB - challenge is inactive
      dynamoMock.on(GetItemCommand).resolves({
        Item: { active: { BOOL: false } },
      });

      const event = createKafkaEvent(testPayload);
      const result = await handler(event);

      expect(result.batchItemFailures).toHaveLength(0);
      expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    });

    test('should skip unknown challenges (not in DynamoDB)', async () => {
      const testPayload = {
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      };

      // Mock DynamoDB - challenge not found
      dynamoMock.on(GetItemCommand).resolves({});

      const event = createKafkaEvent(testPayload);
      const result = await handler(event);

      expect(result.batchItemFailures).toHaveLength(0);
      expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    });
  });

  describe('SNS Publishing', () => {
    test('should publish to SNS with challengeId message attribute', async () => {
      const testPayload = {
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      };

      dynamoMock.on(GetItemCommand).resolves({
        Item: { active: { BOOL: true } },
      });
      snsMock.on(PublishCommand).resolves({ MessageId: 'test-message-id' });

      const event = createKafkaEvent(testPayload);
      await handler(event);

      const snsCalls = snsMock.commandCalls(PublishCommand);
      expect(snsCalls).toHaveLength(1);

      const snsInput = snsCalls[0].args[0].input;
      expect(snsInput.TopicArn).toBe('arn:aws:sns:us-east-1:123456789012:test-topic');
      expect(snsInput.MessageAttributes.challengeId.StringValue).toBe('22222222-2222-2222-2222-222222222222');
    });
  });

  describe('Batch Processing', () => {
    test('should process multiple records in batch', async () => {
      const message1 = JSON.stringify({
        payload: {
          submissionId: '11111111-1111-1111-1111-111111111111',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      });
      const message2 = JSON.stringify({
        payload: {
          submissionId: '33333333-3333-3333-3333-333333333333',
          challengeId: '22222222-2222-2222-2222-222222222222',
        },
      });

      const event = {
        records: {
          'submission.notification.create-0': [
            { topic: 'submission.notification.create', partition: 0, offset: 100, value: Buffer.from(message1).toString('base64') },
            { topic: 'submission.notification.create', partition: 0, offset: 101, value: Buffer.from(message2).toString('base64') },
          ],
        },
      };

      dynamoMock.on(GetItemCommand).resolves({ Item: { active: { BOOL: true } } });
      snsMock.on(PublishCommand).resolves({ MessageId: 'test-message-id' });

      const result = await handler(event);

      expect(result.batchItemFailures).toHaveLength(0);
      expect(snsMock.commandCalls(PublishCommand)).toHaveLength(2);
    });
  });
});
