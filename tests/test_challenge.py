"""Tests for the Challenge Lambda."""
import json
import pytest
from unittest.mock import patch, MagicMock

import sys
sys.path.insert(0, '../challenge_lambda')


class TestConfigLoader:
    """Tests for the config loader."""

    @patch('challenge_lambda.config_loader.boto3')
    def test_load_config_fetches_from_ssm(self, mock_boto3):
        """Test config loader fetches from SSM Parameter Store."""
        from challenge_lambda.config_loader import load_config, invalidate_cache

        # Reset cache
        invalidate_cache()

        mock_ssm = MagicMock()
        mock_boto3.client.return_value = mock_ssm

        config_data = {
            'challengeId': 'challenge-123',
            'ecsCluster': 'my-cluster',
            'ecsTaskDefinition': 'my-task-def'
        }

        mock_ssm.get_parameter.return_value = {
            'Parameter': {
                'Value': json.dumps(config_data)
            }
        }

        with patch.dict('os.environ', {'CHALLENGE_ID': 'challenge-123'}):
            result = load_config()

        assert result == config_data
        mock_ssm.get_parameter.assert_called_once_with(
            Name='/mm-processor/challenges/challenge-123/config',
            WithDecryption=True
        )

    @patch('challenge_lambda.config_loader.boto3')
    def test_load_config_caches_result(self, mock_boto3):
        """Test config loader caches result for subsequent calls."""
        from challenge_lambda.config_loader import load_config, invalidate_cache

        # Reset cache
        invalidate_cache()

        mock_ssm = MagicMock()
        mock_boto3.client.return_value = mock_ssm

        config_data = {'challengeId': 'challenge-123'}
        mock_ssm.get_parameter.return_value = {
            'Parameter': {'Value': json.dumps(config_data)}
        }

        with patch.dict('os.environ', {'CHALLENGE_ID': 'challenge-123'}):
            load_config()
            load_config()
            load_config()

        # Should only call SSM once due to caching
        assert mock_ssm.get_parameter.call_count == 1


class TestEcsRunner:
    """Tests for the ECS task runner."""

    @patch('challenge_lambda.ecs_runner.ecs')
    def test_run_scorer_task_launches_fargate(self, mock_ecs):
        """Test ECS runner launches Fargate task with correct parameters."""
        from challenge_lambda.ecs_runner import run_scorer_task

        mock_ecs.run_task.return_value = {
            'tasks': [{'taskArn': 'arn:aws:ecs:us-east-1:123456789:task/my-cluster/task-id'}]
        }

        config = {
            'challengeId': 'challenge-123',
            'ecsCluster': 'my-cluster',
            'ecsTaskDefinition': 'my-task-def'
        }

        submission = {
            'id': 'submission-456',
            'url': 'https://example.com/submission.zip',
            'memberId': 'member-789'
        }

        with patch.dict('os.environ', {
            'SUBNETS': 'subnet-1,subnet-2',
            'SECURITY_GROUP': 'sg-123'
        }):
            result = run_scorer_task(config, submission)

        assert result == 'arn:aws:ecs:us-east-1:123456789:task/my-cluster/task-id'

        mock_ecs.run_task.assert_called_once()
        call_args = mock_ecs.run_task.call_args

        assert call_args.kwargs['cluster'] == 'my-cluster'
        assert call_args.kwargs['taskDefinition'] == 'my-task-def'
        assert call_args.kwargs['launchType'] == 'FARGATE'

        # Verify container overrides
        overrides = call_args.kwargs['overrides']['containerOverrides'][0]
        assert overrides['name'] == 'scorer'

        env_vars = {e['name']: e['value'] for e in overrides['environment']}
        assert env_vars['SUBMISSION_ID'] == 'submission-456'
        assert env_vars['CHALLENGE_ID'] == 'challenge-123'
        assert env_vars['SUBMISSION_URL'] == 'https://example.com/submission.zip'
        assert env_vars['MEMBER_ID'] == 'member-789'


class TestChallengeHandler:
    """Tests for the Challenge Lambda handler."""

    @patch('challenge_lambda.handler.run_scorer_task')
    @patch('challenge_lambda.handler.load_config')
    def test_handler_processes_sqs_message(self, mock_load_config, mock_run_task):
        """Test handler processes SQS message and launches ECS task."""
        mock_config = {'challengeId': 'challenge-123'}
        mock_load_config.return_value = mock_config
        mock_run_task.return_value = 'arn:aws:ecs:task-arn'

        # Need to reload the module to pick up the mocked config
        import importlib
        import challenge_lambda.handler
        importlib.reload(challenge_lambda.handler)

        from challenge_lambda.handler import handler

        submission = {
            'id': 'submission-456',
            'url': 'https://example.com/submission.zip',
            'memberId': 'member-789'
        }

        event = {
            'Records': [
                {'body': json.dumps(submission)}
            ]
        }

        result = handler(event, None)

        assert result['statusCode'] == 200
        mock_run_task.assert_called_once()

    @patch('challenge_lambda.handler.run_scorer_task')
    @patch('challenge_lambda.handler.load_config')
    def test_handler_unwraps_sns_message(self, mock_load_config, mock_run_task):
        """Test handler unwraps SNS message wrapper."""
        mock_config = {'challengeId': 'challenge-123'}
        mock_load_config.return_value = mock_config
        mock_run_task.return_value = 'arn:aws:ecs:task-arn'

        import importlib
        import challenge_lambda.handler
        importlib.reload(challenge_lambda.handler)

        from challenge_lambda.handler import handler

        submission = {
            'id': 'submission-456',
            'url': 'https://example.com/submission.zip',
            'memberId': 'member-789'
        }

        # SNS wraps the message
        sns_message = {
            'Message': json.dumps(submission)
        }

        event = {
            'Records': [
                {'body': json.dumps(sns_message)}
            ]
        }

        result = handler(event, None)

        assert result['statusCode'] == 200
        mock_run_task.assert_called_once()

        # Verify the unwrapped submission was passed
        call_args = mock_run_task.call_args
        assert call_args[0][1]['id'] == 'submission-456'
