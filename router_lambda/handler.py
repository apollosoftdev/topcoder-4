"""Router Lambda handler for processing MSK Kafka messages."""
import json
import base64
import os
import boto3
from validator import validate_submission

sns = boto3.client('sns')
SNS_TOPIC_ARN = os.environ['SNS_TOPIC_ARN']


def handler(event, context):
    """Process MSK Kafka messages and route to SNS."""
    for topic_partition, records in event['records'].items():
        for record in records:
            try:
                # Decode Kafka message
                message = json.loads(base64.b64decode(record['value']).decode('utf-8'))

                # Validate
                if not validate_submission(message):
                    print(f"Invalid submission: {message}")
                    continue

                # Publish to SNS with challenge ID filter attribute
                sns.publish(
                    TopicArn=SNS_TOPIC_ARN,
                    Message=json.dumps(message),
                    MessageAttributes={
                        'challengeId': {
                            'DataType': 'String',
                            'StringValue': message['challengeId']
                        }
                    }
                )
                print(f"Routed submission {message.get('id')} to challenge {message['challengeId']}")

            except Exception as e:
                print(f"Error processing record: {e}")
                raise  # Let Lambda retry

    return {'statusCode': 200}
