/**
 * Lambda authorizer (lld.md §2.1): every request carries
 * `Authorization: Bearer <token>`; on a valid HMAC the identity lands in the
 * request context and handlers never read identity from the body. The secret
 * is generated at deploy time (Secrets Manager) and cached per container.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';
import { requireEnv, type Identity } from '../http/api';
import { verifyToken } from './token';

type AuthResult = APIGatewaySimpleAuthorizerWithContextResult<Identity | Record<string, never>>;

const DENY: AuthResult = { isAuthorized: false, context: {} };

let cachedSecret: Promise<string> | undefined;

function simSecret(): Promise<string> {
  return (cachedSecret ??= new SecretsManagerClient({})
    .send(new GetSecretValueCommand({ SecretId: requireEnv('SIM_SECRET_ARN') }))
    .then((out) => {
      if (!out.SecretString) throw new Error('SIM_SECRET has no value');
      return out.SecretString;
    })
    .catch((error: unknown) => {
      cachedSecret = undefined; // do not cache failures
      throw error;
    }));
}

export async function handler(event: APIGatewayRequestAuthorizerEventV2): Promise<AuthResult> {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!header?.startsWith('Bearer ')) return DENY;
  const identity = verifyToken(header.slice('Bearer '.length), await simSecret());
  if (!identity) return DENY;
  return { isAuthorized: true, context: identity };
}
