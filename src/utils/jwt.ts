import jwt from 'jsonwebtoken';

const signingSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET debe configurarse antes de iniciar el servicio');
  return secret;
};
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export interface TokenPayload {
  userId: string;
  roles: string[];
}

export const generateToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, signingSecret(), {
    expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
};

export const verifyToken = (token: string): TokenPayload => {
  const decoded = jwt.verify(token, signingSecret(), { algorithms: ['HS256'] });
  if (typeof decoded === 'string' || typeof decoded.userId !== 'string') throw new jwt.JsonWebTokenError('Invalid token payload');
  return decoded as TokenPayload;
};
