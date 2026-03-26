import { Request, Response, NextFunction } from 'express';

// Mock supabase before importing auth middleware
const mockGetUser = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: mockGetUser,
    },
  }),
}));

// Set required env vars before importing
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

import { authMiddleware } from '../src/middleware/auth';

function createMockReq(authHeader?: string): Partial<Request> {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  };
}

function createMockRes(): Partial<Response> & { statusCode: number; body: any } {
  const res: any = {
    statusCode: 0,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

describe('Auth Middleware', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 when no Authorization header is provided', async () => {
    const req = createMockReq() as Request;
    const res = createMockRes() as any;
    const next = jest.fn() as NextFunction;

    await authMiddleware(req as any, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/Missing/i);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when Authorization header has no Bearer prefix', async () => {
    const req = createMockReq('Basic sometoken') as Request;
    const res = createMockRes() as any;
    const next = jest.fn() as NextFunction;

    await authMiddleware(req as any, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when token is invalid', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid token' },
    });

    const req = createMockReq('Bearer invalid-token') as Request;
    const res = createMockRes() as any;
    const next = jest.fn() as NextFunction;

    await authMiddleware(req as any, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/Invalid|expired/i);
    expect(next).not.toHaveBeenCalled();
  });

  it('should call next() and attach user when token is valid', async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: 'user-123',
          email: 'test@example.com',
        },
      },
      error: null,
    });

    const req = createMockReq('Bearer valid-token') as any;
    const res = createMockRes() as any;
    const next = jest.fn() as NextFunction;

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({
      id: 'user-123',
      email: 'test@example.com',
    });
  });
});
