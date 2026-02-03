import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('events', () => {
  it('buffers events and adds a timestamp when missing', async () => {
    const { logEvent, getRecentEvents } = await import('./events');

    vi.spyOn(console, 'log').mockImplementation(() => {});

    logEvent({ type: 'request', success: true });

    const events = getRecentEvents(10);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('request');
    expect(events[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('type=request'),
      ''
    );
  });

  it('caps the buffer at 100 events', async () => {
    const { logEvent, getRecentEvents } = await import('./events');

    vi.spyOn(console, 'log').mockImplementation(() => {});

    for (let i = 0; i < 101; i++) {
      logEvent({
        type: 'request',
        success: true,
        details: { index: i },
        timestamp: `2026-02-01T00:00:${String(i).padStart(2, '0')}Z`,
      });
    }

    const events = getRecentEvents(200);
    expect(events).toHaveLength(100);
    expect(events[0].details).toEqual({ index: 1 });
    expect(events[99].details).toEqual({ index: 100 });
  });

  it('helper logRestartEvent includes reason in details', async () => {
    const { logRestartEvent, getRecentEvents } = await import('./events');

    vi.spyOn(console, 'log').mockImplementation(() => {});

    logRestartEvent('user-123456789', true, 'manual', { previousFailures: 2 });

    const [event] = getRecentEvents(1);
    expect(event.type).toBe('restart');
    expect(event.success).toBe(true);
    expect(event.userId).toBe('user-123456789');
    expect(event.details).toEqual({ reason: 'manual', previousFailures: 2 });
  });

  it('helper logErrorEvent forces success=false and nests error string', async () => {
    const { logErrorEvent, getRecentEvents } = await import('./events');

    vi.spyOn(console, 'log').mockImplementation(() => {});

    logErrorEvent('boom', 'user-123', { extra: 'x' });

    const [event] = getRecentEvents(1);
    expect(event.type).toBe('error');
    expect(event.success).toBe(false);
    expect(event.userId).toBe('user-123');
    expect(event.details).toEqual({ error: 'boom', extra: 'x' });
  });
});

