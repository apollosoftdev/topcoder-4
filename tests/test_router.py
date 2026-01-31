"""Tests for the Router Lambda."""
import json
import base64
import pytest
from unittest.mock import patch, MagicMock

import sys
sys.path.insert(0, '../router_lambda')

from router_lambda.validator import validate_submission


class TestValidator:
    """Tests for the submission validator."""

    def test_validate_submission_valid(self):
        """Test validation with all required fields."""
        message = {
            'id': 'submission-123',
            'challengeId': 'challenge-456',
            'url': 'https://example.com/submission.zip',
            'memberId': 'member-789'
        }
        assert validate_submission(message) is True

    def test_validate_submission_missing_id(self):
        """Test validation fails when id is missing."""
        message = {
            'challengeId': 'challenge-456',
            'url': 'https://example.com/submission.zip',
            'memberId': 'member-789'
        }
        assert validate_submission(message) is False

    def test_validate_submission_missing_challenge_id(self):
        """Test validation fails when challengeId is missing."""
        message = {
            'id': 'submission-123',
            'url': 'https://example.com/submission.zip',
            'memberId': 'member-789'
        }
        assert validate_submission(message) is False

    def test_validate_submission_missing_url(self):
        """Test validation fails when url is missing."""
        message = {
            'id': 'submission-123',
            'challengeId': 'challenge-456',
            'memberId': 'member-789'
        }
        assert validate_submission(message) is False

    def test_validate_submission_missing_member_id(self):
        """Test validation fails when memberId is missing."""
        message = {
            'id': 'submission-123',
            'challengeId': 'challenge-456',
            'url': 'https://example.com/submission.zip'
        }
        assert validate_submission(message) is False

    def test_validate_submission_empty_message(self):
        """Test validation fails with empty message."""
        assert validate_submission({}) is False

    def test_validate_submission_extra_fields(self):
        """Test validation passes with extra fields."""
        message = {
            'id': 'submission-123',
            'challengeId': 'challenge-456',
            'url': 'https://example.com/submission.zip',
            'memberId': 'member-789',
            'extra_field': 'extra_value'
        }
        assert validate_submission(message) is True


class TestRouterHandler:
    """Tests for the Router Lambda handler."""

    @patch('router_lambda.handler.sns')
    def test_handler_routes_valid_message(self, mock_sns):
        """Test handler routes valid message to SNS."""
        # Import handler after patching
        from router_lambda.handler import handler

        message = {
            'id': 'submission-123',
            'challengeId': 'challenge-456',
            'url': 'https://example.com/submission.zip',
            'memberId': 'member-789'
        }

        event = {
            'records': {
                'topic-0': [{
                    'value': base64.b64encode(json.dumps(message).encode()).decode()
                }]
            }
        }

        with patch.dict('os.environ', {'SNS_TOPIC_ARN': 'arn:aws:sns:us-east-1:123456789:test-topic'}):
            result = handler(event, None)

        assert result['statusCode'] == 200
        mock_sns.publish.assert_called_once()

    @patch('router_lambda.handler.sns')
    def test_handler_skips_invalid_message(self, mock_sns):
        """Test handler skips invalid messages without publishing."""
        from router_lambda.handler import handler

        message = {'id': 'submission-123'}  # Missing required fields

        event = {
            'records': {
                'topic-0': [{
                    'value': base64.b64encode(json.dumps(message).encode()).decode()
                }]
            }
        }

        with patch.dict('os.environ', {'SNS_TOPIC_ARN': 'arn:aws:sns:us-east-1:123456789:test-topic'}):
            result = handler(event, None)

        assert result['statusCode'] == 200
        mock_sns.publish.assert_not_called()

    @patch('router_lambda.handler.sns')
    def test_handler_multiple_records(self, mock_sns):
        """Test handler processes multiple records."""
        from router_lambda.handler import handler

        messages = [
            {
                'id': f'submission-{i}',
                'challengeId': f'challenge-{i}',
                'url': f'https://example.com/submission-{i}.zip',
                'memberId': f'member-{i}'
            }
            for i in range(3)
        ]

        event = {
            'records': {
                'topic-0': [
                    {'value': base64.b64encode(json.dumps(m).encode()).decode()}
                    for m in messages
                ]
            }
        }

        with patch.dict('os.environ', {'SNS_TOPIC_ARN': 'arn:aws:sns:us-east-1:123456789:test-topic'}):
            result = handler(event, None)

        assert result['statusCode'] == 200
        assert mock_sns.publish.call_count == 3
