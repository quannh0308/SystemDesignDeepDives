/** Real DynamoDB DocumentClient for Lambda entries; unit tests inject fakes via `StoreClient`. */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let cached: DynamoDBDocumentClient | undefined;

export function docClient(): DynamoDBDocumentClient {
  return (cached ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }));
}
