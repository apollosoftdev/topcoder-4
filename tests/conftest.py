"""Pytest configuration and fixtures."""
import sys
import os
import pytest

# Add Lambda directories to Python path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'router_lambda'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'challenge_lambda'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'completion_lambda'))


@pytest.fixture(autouse=True)
def reset_environment():
    """Reset environment variables between tests."""
    original_env = os.environ.copy()
    yield
    os.environ.clear()
    os.environ.update(original_env)


@pytest.fixture
def valid_submission():
    """Return a valid submission message."""
    return {
        'id': 'submission-123',
        'challengeId': 'challenge-456',
        'url': 'https://example.com/submission.zip',
        'memberId': 'member-789'
    }


@pytest.fixture
def ecs_task_event():
    """Return a sample ECS task state change event."""
    return {
        'version': '0',
        'id': 'event-123',
        'detail-type': 'ECS Task State Change',
        'source': 'aws.ecs',
        'account': '123456789012',
        'time': '2024-01-15T10:00:00Z',
        'region': 'us-east-1',
        'detail': {
            'taskArn': 'arn:aws:ecs:us-east-1:123456789:task/cluster/task-id',
            'clusterArn': 'arn:aws:ecs:us-east-1:123456789:cluster/my-cluster',
            'lastStatus': 'STOPPED',
            'stoppedReason': 'Essential container exited',
            'group': 'family:mm-scorer',
            'overrides': {
                'containerOverrides': [{
                    'name': 'scorer',
                    'environment': [
                        {'name': 'SUBMISSION_ID', 'value': 'submission-456'},
                        {'name': 'CHALLENGE_ID', 'value': 'challenge-789'}
                    ]
                }]
            },
            'containers': [{
                'name': 'scorer',
                'exitCode': 0
            }]
        }
    }
