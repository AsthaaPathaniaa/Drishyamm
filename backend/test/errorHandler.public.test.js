// errorHandler hides every 5xx message, except fixed text marked for the user
// with AppError.public() ("Smart Search isn't switched on…").
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
const errorHandler = require('../src/middleware/errorHandler');
const AppError = require('../src/utils/AppError');

function reply(err) {
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  errorHandler(err, { method: 'GET', originalUrl: '/x', ip: '1.2.3.4' }, res, () => {});
  return res;
}

test('a public 5xx keeps its message', () => {
  const r = reply(AppError.public('Smart Search isn’t switched on for this server yet.', 503));
  expect(r.statusCode).toBe(503);
  expect(r.body.message).toBe('Smart Search isn’t switched on for this server yet.');
});

test('an ordinary 5xx AppError is still hidden', () => {
  const r = reply(new AppError('upstream said: secret detail', 502));
  expect(r.statusCode).toBe(502);
  expect(r.body.message).toBe('Internal Server Error');
});

test('a thrown error that merely carries expose is still hidden', () => {
  const e = Object.assign(new Error('SELECT * FROM users'), { statusCode: 500, expose: true });
  expect(reply(e).body.message).toBe('Internal Server Error');
});

test('4xx messages are unchanged', () => {
  expect(reply(new AppError('Camera not found.', 404)).body.message).toBe('Camera not found.');
});
