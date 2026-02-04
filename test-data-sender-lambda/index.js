const { Kafka } = require('kafkajs');
// Import AWS SDK v3 Kafka client
const { KafkaClient, GetBootstrapBrokersCommand } = require("@aws-sdk/client-kafka");

// Retrieve environment variables
const topic = process.env.TARGET_TOPIC;
const clusterArn = process.env.MSK_CLUSTER_ARN; // Expect cluster ARN now

if (!topic || !clusterArn) {
  throw new Error('TARGET_TOPIC and MSK_CLUSTER_ARN environment variables are required.');
}

// AWS SDK Kafka Client (for getting brokers)
const kafkaClient = new KafkaClient({});

// KafkaJS Client (initialized later)
let kafka;
let producer;
let producerConnected = false;
let adminClient;

// Function to get brokers and initialize KafkaJS client/admin
const initializeKafka = async () => {
  if (kafka) return; // Already initialized

  console.log(`Fetching bootstrap brokers for cluster: ${clusterArn}`);
  const command = new GetBootstrapBrokersCommand({ ClusterArn: clusterArn });
  const response = await kafkaClient.send(command);
  
  if (!response.BootstrapBrokerStringTls) {
      throw new Error('Failed to retrieve TLS bootstrap brokers from MSK.');
  }
  const bootstrapServers = response.BootstrapBrokerStringTls.split(',');
  console.log(`Retrieved Bootstrap Brokers: ${bootstrapServers.join(',')}`);

  // Configure KafkaJS client
  kafka = new Kafka({
    clientId: 'lambda-publisher',
    brokers: bootstrapServers,
    ssl: true, 
  });

  producer = kafka.producer();
  adminClient = kafka.admin(); // Create admin client instance

  // --- Try to create topic --- 
  console.log(`Ensuring topic '${topic}' exists...`);
  await adminClient.connect();
  try {
    await adminClient.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic: topic,
          numPartitions: 2, // Match broker count for simplicity
          replicationFactor: 2 // Match broker count for simplicity
        }
      ]
    });
    console.log(`Topic '${topic}' created or already exists.`);
  } catch (error) {
    // Error code 36 is TOPIC_ALREADY_EXISTS
    if (error.code === 36) {
      console.log(`Topic '${topic}' already exists.`);
    } else {
      console.error('Failed to create topic %s:', topic, error);
      // Rethrow if it's not a "topic already exists" error
      throw error; 
    }
  } finally {
    await adminClient.disconnect();
    console.log('Kafka Admin client disconnected.');
  }
  // --- End topic creation --- 
};

// Function to ensure producer is connected
const ensureProducerConnected = async () => {
  if (!producer) {
      await initializeKafka(); // Initialize if not already done
  }
  if (!producerConnected) {
    await producer.connect();
    producerConnected = true;
    console.log('Kafka Producer connected successfully.');
  }
};

exports.handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  // Expecting the event itself to be the JSON message object to send
  let messageToSend;
  try {
    // Input might be stringified JSON (e.g., from API Gateway or direct invoke)
    // or already an object (e.g., test event in console)
    messageToSend = typeof event === 'string' ? event : JSON.stringify(event);
  } catch (parseError) {
    console.error('Failed to stringify event:', parseError);
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Invalid input format. Could not stringify event.' }),
    };
  }

  try {
    await ensureProducerConnected();
    console.log(`Publishing message to topic: ${topic}`);

    const result = await producer.send({
      topic: topic,
      messages: [
        // KafkaJS expects the message value to be a string or buffer
        { value: messageToSend }, 
      ],
    });

    console.log('Message published successfully:', JSON.stringify(result));
    
    // Keep producer connected for potential warm reuse, 
    // or uncomment disconnect for explicit cleanup per invocation:
    // await producer.disconnect(); 
    // producerConnected = false;
    // console.log('Producer disconnected.');

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Message published successfully', result }),
    };
  } catch (error) {
    console.error('Error publishing message:', error);
    // Attempt to disconnect producer on error
    if (producerConnected) {
      try { 
        await producer.disconnect(); 
        producerConnected = false;
        console.log('Producer disconnected after error.');
      } catch (e) { 
        console.error('Error disconnecting producer after error:', e); 
      }
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Failed to publish message', error: error.message }),
    };
  }
}; 