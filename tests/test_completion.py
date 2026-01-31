"""Tests for the Completion Lambda."""
import json
import pytest
from unittest.mock import patch, MagicMock

import sys
sys.path.insert(0, '../completion_lambda')


class TestSubmissionApi:
    """Tests for the submission API client."""

    @patch('completion_lambda.submission_api.boto3')
    def test_get_auth_token_fetches_from_ssm(self, mock_boto3):
        """Test auth token is fetched from SSM Parameter Store."""
        from completion_lambda.submission_api import get_auth_token, invalidate_token_cache

        # Reset cache
        invalidate_token_cache()

        mock_ssm = MagicMock()
        mock_boto3.client.return_value = mock_ssm

        mock_ssm.get_parameter.return_value = {
            'Parameter': {'Value': 'test-token-123'}
        }

        result = get_auth_token()

        assert result == 'test-token-123'
        mock_ssm.get_parameter.assert_called_once_with(
            Name='/mm-processor/auth0/token',
            WithDecryption=True
        )

    @patch('completion_lambda.submission_api.boto3')
    def test_get_auth_token_caches_result(self, mock_boto3):
        """Test auth token is cached for subsequent calls."""
        from completion_lambda.submission_api import get_auth_token, invalidate_token_cache

        # Reset cache
        invalidate_token_cache()

        mock_ssm = MagicMock()
        mock_boto3.client.return_value = mock_ssm

        mock_ssm.get_parameter.return_value = {
            'Parameter': {'Value': 'test-token-123'}
        }

        get_auth_token()
        get_auth_token()
        get_auth_token()

        # Should only call SSM once due to caching
        assert mock_ssm.get_parameter.call_count == 1

    @patch('completion_lambda.submission_api.requests')
    @patch('completion_lambda.submission_api.get_auth_token')
    def test_update_submission_status_success(self, mock_get_token, mock_requests):
        """Test successful submission status update."""
        from completion_lambda.submission_api import update_submission_status

        mock_get_token.return_value = 'test-token-123'
        mock_response = MagicMock()
        mock_requests.patch.return_value = mock_response

        with patch.dict('os.environ', {'SUBMISSION_API_URL': 'https://api.example.com'}):
            update_submission_status(
                submission_id='submission-456',
                status='SCORED',
                task_arn='arn:aws:ecs:task-arn',
                stopped_reason='Essential container exited'
            )

        mock_requests.patch.assert_called_once_with(
            'https://api.example.com/submissions/submission-456',
            headers={
                'Authorization': 'Bearer test-token-123',
                'Content-Type': 'application/json'
            },
            json={
                'status': 'SCORED',
                'metadata': {
                    'taskArn': 'arn:aws:ecs:task-arn',
                    'stoppedReason': 'Essential container exited'
                }
            },
            timeout=30
        )
        mock_response.raise_for_status.assert_called_once()


class TestCompletionHandler:
    """Tests for the Completion Lambda handler."""

    @patch('completion_lambda.handler.update_submission_status')
    def test_handler_success_exit_code(self, mock_update):
        """Test handler updates status to SCORED for exit code 0."""
        from completion_lambda.handler import handler

        event = {
            'detail': {
                'taskArn': 'arn:aws:ecs:us-east-1:123456789:task/cluster/task-id',
                'stoppedReason': 'Essential container exited',
                'overrides': {
                    'containerOverrides': [{
                        'name': 'scorer',
                        'environment': [
                            {'name': 'SUBMISSION_ID', 'value': 'submission-456'}
                        ]
                    }]
                },
                'containers': [{
                    'name': 'scorer',
                    'exitCode': 0
                }]
            }
        }

        result = handler(event, None)

        assert result['statusCode'] == 200
        mock_update.assert_called_once_with(
            submission_id='submission-456',
            status='SCORED',
            task_arn='arn:aws:ecs:us-east-1:123456789:task/cluster/task-id',
            stopped_reason='Essential container exited'
        )

    @patch('completion_lambda.handler.update_submission_status')
    def test_handler_failure_exit_code(self, mock_update):
        """Test handler updates status to FAILED for non-zero exit code."""
        from completion_lambda.handler import handler

        event = {
            'detail': {
                'taskArn': 'arn:aws:ecs:us-east-1:123456789:task/cluster/task-id',
                'stoppedReason': 'Task failed',
                'overrides': {
                    'containerOverrides': [{
                        'name': 'scorer',
                        'environment': [
                            {'name': 'SUBMISSION_ID', 'value': 'submission-456'}
                        ]
                    }]
                },
                'containers': [{
                    'name': 'scorer',
                    'exitCode': 1
                }]
            }
        }

        result = handler(event, None)

        assert result['statusCode'] == 200
        mock_update.assert_called_once_with(
            submission_id='submission-456',
            status='FAILED',
            task_arn='arn:aws:ecs:us-east-1:123456789:task/cluster/task-id',
            stopped_reason='Task failed'
        )

    @patch('completion_lambda.handler.update_submission_status')
    def test_handler_missing_submission_id(self, mock_update):
        """Test handler returns 400 when submission ID is not found."""
        from completion_lambda.handler import handler

        event = {
            'detail': {
                'taskArn': 'arn:aws:ecs:us-east-1:123456789:task/cluster/task-id',
                'stoppedReason': 'Task completed',
                'overrides': {
                    'containerOverrides': [{
                        'name': 'other-container',
                        'environment': []
                    }]
                },
                'containers': []
            }
        }

        result = handler(event, None)

        assert result['statusCode'] == 400
        mock_update.assert_not_called()

    @patch('completion_lambda.handler.update_submission_status')
    def test_handler_no_scorer_container(self, mock_update):
        """Test handler marks as FAILED when scorer container not found."""
        from completion_lambda.handler import handler

        event = {
            'detail': {
                'taskArn': 'arn:aws:ecs:us-east-1:123456789:task/cluster/task-id',
                'stoppedReason': 'Task completed',
                'overrides': {
                    'containerOverrides': [{
                        'name': 'scorer',
                        'environment': [
                            {'name': 'SUBMISSION_ID', 'value': 'submission-456'}
                        ]
                    }]
                },
                'containers': [{
                    'name': 'other-container',
                    'exitCode': 0
                }]
            }
        }

        result = handler(event, None)

        assert result['statusCode'] == 200
        mock_update.assert_called_once()
        # Should be FAILED since scorer container wasn't found
        call_args = mock_update.call_args
        assert call_args.kwargs['status'] == 'FAILED'
