# AWS Infrastructure for ERC-2771 Gasless Transaction System

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# Variables
variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

# SQS Queue for Meta Transactions
resource "aws_sqs_queue" "meta_tx_queue" {
  name                        = "meta-transaction-queue.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  visibility_timeout_seconds  = 300
  message_retention_seconds   = 86400  # 24 hours

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.meta_tx_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    Environment = var.environment
    Service     = "gasless-relayer"
  }
}

# Dead Letter Queue for Failed Transactions
resource "aws_sqs_queue" "meta_tx_dlq" {
  name                      = "meta-transaction-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600  # 14 days

  tags = {
    Environment = var.environment
    Service     = "gasless-relayer"
  }
}

# KMS Key for Relayer's Private Key
resource "aws_kms_key" "relayer_key" {
  description             = "KMS key for relayer's private key"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = {
    Environment = var.environment
    Service     = "gasless-relayer"
  }
}

resource "aws_kms_alias" "relayer_key_alias" {
  name          = "alias/relayer-key"
  target_key_id = aws_kms_key.relayer_key.key_id
}

# Lambda Function for Transaction Processing
resource "aws_lambda_function" "relayer" {
  filename         = "lambda/relayer.zip"
  function_name    = "meta-transaction-relayer"
  role            = aws_iam_role.lambda_role.arn
  handler         = "index.handler"
  runtime         = "nodejs18.x"
  timeout         = 60
  memory_size     = 1024

  environment {
    variables = {
      QUEUE_URL = aws_sqs_queue.meta_tx_queue.url
      KMS_KEY_ID = aws_kms_key.relayer_key.key_id
    }
  }

  tags = {
    Environment = var.environment
    Service     = "gasless-relayer"
  }
}

# IAM Role for Lambda
resource "aws_iam_role" "lambda_role" {
  name = "relayer-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

# IAM Policy for Lambda
resource "aws_iam_role_policy" "lambda_policy" {
  name = "relayer-lambda-policy"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = [
          aws_sqs_queue.meta_tx_queue.arn,
          aws_sqs_queue.meta_tx_dlq.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey"
        ]
        Resource = aws_kms_key.relayer_key.arn
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      }
    ]
  })
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "relayer_logs" {
  name              = "/aws/lambda/meta-transaction-relayer"
  retention_in_days = 14

  tags = {
    Environment = var.environment
    Service     = "gasless-relayer"
  }
}

# CloudWatch Alarms
resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  alarm_name          = "meta-tx-dlq-messages"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace          = "AWS/SQS"
  period             = "300"
  statistic          = "Average"
  threshold          = "0"
  alarm_description  = "This metric monitors number of messages in DLQ"

  dimensions = {
    QueueName = aws_sqs_queue.meta_tx_dlq.name
  }
}
