const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

const sns = new SNSClient();
const dynamodb = new DynamoDBClient();

// Configuration from environment variables
const config = {
  snsTopicArn: process.env.SNS_TOPIC_ARN,
  challengeMappingTable: process.env.CHALLENGE_MAPPING_TABLE,
};

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a string is a valid UUID
 * @param {string} value - Value to validate
 * @returns {boolean} - True if valid UUID
 */
const isValidUuid = (value) => {
  return typeof value === 'string' && UUID_REGEX.test(value);
};

/**
 * Check if a challenge is active in DynamoDB
 * @param {string} challengeId - Challenge UUID to check
 * @returns {Promise<boolean>} - True if challenge is active
 */
const isChallengeActive = async (challengeId) => {
  try {
    const command = new GetItemCommand({
      TableName: config.challengeMappingTable,
      Key: {
        challengeId: { S: challengeId },
      },
      ProjectionExpression: 'active',
    });
    const response = await dynamodb.send(command);

    if (!response.Item) {
      console.log(`Challenge ${challengeId} not found in mapping table`);
      return false;
    }

    const isActive = response.Item.active?.BOOL === true;
    console.log(`Challenge ${challengeId} active status: ${isActive}`);
    return isActive;
  } catch (error) {
    console.error(`Error checking challenge status for ${challengeId}:`, error);
    return false;
  }
};

/**
 * Publish message to SNS with challengeId attribute for filtering
 * @param {Object} message - Message to publish
 * @param {string} challengeId - Challenge ID for message attribute
 * @returns {Promise<Object>} - SNS publish response
 */
const publishToSns = async (message, challengeId) => {
  const command = new PublishCommand({
    TopicArn: config.snsTopicArn,
    Message: JSON.stringify(message),
    MessageAttributes: {
      challengeId: {
        DataType: 'String',
        StringValue: challengeId,
      },
    },
  });

  const response = await sns.send(command);
  console.log(`Published message to SNS for challenge ${challengeId}, MessageId: ${response.MessageId}`);
  return response;
};

/**
 * Process a single Kafka record
 * @param {Object} record - Kafka record
 * @returns {Promise<{success: boolean, itemIdentifier: string}>} - Processing result
 */
const processRecord = async (record) => {
  const itemIdentifier = `${record.topic}-${record.partition}-${record.offset}`;

  try {
    // Decode base64 Kafka message
    const decodedValue = Buffer.from(record.value, 'base64').toString('utf-8');
    const message = JSON.parse(decodedValue);

    // Extract submission details
    const submissionId = message?.payload?.submissionId;
    const challengeId = message?.payload?.challengeId;

    // Validate required fields
    if (!submissionId) {
      console.error('Missing submissionId in message payload:', message);
      return { success: true, itemIdentifier }; // Skip invalid messages
    }

    if (!challengeId) {
      console.error('Missing challengeId in message payload:', message);
      return { success: true, itemIdentifier }; // Skip invalid messages
    }

    // Validate UUIDs
    if (!isValidUuid(submissionId)) {
      console.error(`Invalid submissionId format: ${submissionId}`);
      return { success: true, itemIdentifier }; // Skip invalid messages
    }

    if (!isValidUuid(challengeId)) {
      console.error(`Invalid challengeId format: ${challengeId}`);
      return { success: true, itemIdentifier }; // Skip invalid messages
    }

    // Check if challenge is active
    const active = await isChallengeActive(challengeId);
    if (!active) {
      console.log(`Skipping message for inactive/unknown challenge: ${challengeId}`);
      return { success: true, itemIdentifier };
    }

    // Publish to SNS for fan-out
    await publishToSns(message, challengeId);

    console.log(`Successfully routed submission ${submissionId} for challenge ${challengeId}`);
    return { success: true, itemIdentifier };
  } catch (error) {
    console.error(`Error processing record ${itemIdentifier}:`, error);
    return { success: false, itemIdentifier };
  }
};

/**
 * Lambda handler for MSK events
 * Routes messages to SNS topic based on challengeId
 * @param {Object} event - Lambda event containing Kafka messages
 * @returns {Promise<Object>} - Response with batch item failures
 */
exports.handler = async (event) => {
  console.log('Router Lambda received event:', JSON.stringify(event, null, 2));

  const batchItemFailures = [];
  const promises = [];

  // Process all records from all topic partitions
  for (const topicPartitionKey in event.records) {
    if (Object.hasOwnProperty.call(event.records, topicPartitionKey)) {
      const records = event.records[topicPartitionKey];
      for (const record of records) {
        promises.push(processRecord(record));
      }
    }
  }

  // Wait for all records to be processed
  const results = await Promise.allSettled(promises);

  // Collect failures for partial batch failure reporting
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (!result.value.success) {
        batchItemFailures.push({
          itemIdentifier: result.value.itemIdentifier,
        });
      }
    } else {
      // Promise rejected - this shouldn't happen with our error handling
      console.error('Unexpected promise rejection:', result.reason);
    }
  }

  // Report partial batch failures
  if (batchItemFailures.length > 0) {
    console.log(`Batch processing completed with ${batchItemFailures.length} failures`);
    return { batchItemFailures };
  }

  console.log('Batch processing completed successfully');
  return { batchItemFailures: [] };
};
