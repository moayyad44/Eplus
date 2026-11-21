import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessClaims {
  sub: string;
  sid: string;
}

export const signAccessToken = (claims: AccessClaims) =>
  jwt.sign(claims, env.JWT_SECRET, { expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`, issuer: 'emergencyplus' });

export const verifyAccessToken = (token: string) =>
  jwt.verify(token, env.JWT_SECRET, { issuer: 'emergencyplus' }) as AccessClaims & jwt.JwtPayload;

export const newRefreshToken = () => crypto.randomBytes(48).toString('base64url');
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
