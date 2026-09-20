import express, { type Express } from 'express';
import { ApiError } from '../paths.js';
import type { AccountService } from './account-service.js';
import { createAccountHandler, type AccountTransportPolicy } from './identity-host.js';

/**
 * Optional local development mount, after the existing app's loopback/origin
 * and mutation guards. It changes none of those guards. Remote hosting uses the
 * Fetch handler through the separately qualified B01 deployment boundary.
 */
export function mountAccountRoutes(
  app: Express,
  accounts: AccountService,
  policy: AccountTransportPolicy,
) {
  const handle = createAccountHandler(accounts, policy);
  app.use('/api/account', express.json({ limit: '16kb' }), async (request, response, next) => {
    try {
      if (
        request.rawHeaders.filter(
          (value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization',
        ).length > 1
      )
        throw new ApiError(401, 'Use one bearer authorization header.');
      const headers = new Headers();
      for (const key of [
        'authorization',
        'origin',
        'content-type',
        'access-control-request-method',
        'access-control-request-headers',
      ]) {
        const value = request.headers[key];
        if (Array.isArray(value))
          throw new ApiError(422, 'Repeated account headers are not supported.');
        if (value !== undefined) headers.set(key, value);
      }
      const url = new URL(request.originalUrl, 'http://127.0.0.1');
      url.pathname = url.pathname.slice('/api'.length);
      const result = await handle(
        new Request(url, {
          method: request.method,
          headers,
          body:
            ['GET', 'HEAD', 'OPTIONS'].includes(request.method) || request.body === undefined
              ? undefined
              : JSON.stringify(request.body),
        }),
      );
      result.headers.forEach((value, key) => response.setHeader(key, value));
      response.status(result.status).send(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      next(error);
    }
  });
}
