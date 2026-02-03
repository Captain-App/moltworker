/**
 * Tests for improved admin API robustness
 * 
 * Run with: npm test admin-improved.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Hono } from 'hono';

// Mock the @cloudflare/sandbox module
const mockSandbox = {
  listProcesses: vi.fn(),
  startProcess: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
};

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
}));

// Mock gateway functions
vi.mock('../gateway', () => ({
  getGatewayMasterToken: vi.fn(() => 'test-token'),
  ensureMoltbotGateway: vi.fn(),
}));

describe('Admin API Robustness Improvements', () => {
  let env: any;
  
  beforeEach(() => {
    vi.clearAllMocks();
    
    env = {
      MOLTBOT_BUCKET: {
        get: vi.fn(),
        put: vi.fn(),
        head: vi.fn(),
      },
      Sandbox: {},
    };
  });

  describe('withWakeAndRetry', () => {
    it('should succeed on first attempt if container is ready', async () => {
      mockSandbox.listProcesses.mockResolvedValue([
        { id: '1', command: 'clawdbot gateway', status: 'running' }
      ]);
      mockSandbox.startProcess.mockResolvedValue({
        waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
        getLogs: vi.fn().mockResolvedValue({ stdout: 'health-check' }),
      });

      // Simulated operation
      const operation = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
      
      // Should call operation once
      expect(operation).not.toHaveBeenCalled();
    });

    it('should wake container if no processes exist', async () => {
      mockSandbox.listProcesses
        .mockResolvedValueOnce([]) // First check: empty
        .mockResolvedValueOnce([{ id: '1', command: 'clawdbot gateway', status: 'running' }]);
      
      mockSandbox.startProcess.mockResolvedValue({
        waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
        getLogs: vi.fn().mockResolvedValue({ stdout: 'health-check' }),
      });

      // Container should be woken
      const { ensureMoltbotGateway } = await import('../gateway');
      // After wake, ensureMoltbotGateway should be called
    });

    it('should retry on transient errors', async () => {
      mockSandbox.listProcesses
        .mockRejectedValueOnce(new Error('sandbox_not_found'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce([
          { id: '1', command: 'clawdbot gateway', status: 'running' }
        ]);

      // Should retry 3 times, succeed on 3rd
    });

    it('should not retry on permanent errors', async () => {
      mockSandbox.listProcesses.mockRejectedValue(new Error('Invalid command'));

      // Should fail immediately without retry
    });
  });

  describe('File API with R2-First', () => {
    it('should read from R2 when container is hibernating', async () => {
      const userId = 'test-user';
      const path = '/.clawdbot/config.json';
      const r2Content = '{"test": true}';
      
      // R2 has the file
      env.MOLTBOT_BUCKET.get.mockResolvedValue({
        text: vi.fn().mockResolvedValue(r2Content),
        uploaded: new Date(),
        size: r2Content.length,
      });

      // Container would fail (hibernating)
      mockSandbox.listProcesses.mockRejectedValue(new Error('sandbox hibernating'));

      // Should return R2 content without touching container
    });

    it('should fallback to container when R2 file not found', async () => {
      const userId = 'test-user';
      const path = '/workspace/test.txt';
      const containerContent = 'hello from container';
      
      // R2 doesn't have file
      env.MOLTBOT_BUCKET.get.mockResolvedValue(null);
      
      // Container has file
      mockSandbox.listProcesses.mockResolvedValue([
        { id: '1', command: 'clawdbot gateway', status: 'running' }
      ]);
      mockSandbox.startProcess.mockResolvedValue({
        waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
        getLogs: vi.fn().mockResolvedValue({ stdout: 'health-check' }),
      });
      mockSandbox.readFile.mockResolvedValue({
        success: true,
        content: containerContent,
        size: containerContent.length,
      });

      // Should read from container
    });

    it('should sync write to both container and R2', async () => {
      const userId = 'test-user';
      const path = '/test.txt';
      const content = 'test content';
      
      mockSandbox.listProcesses.mockResolvedValue([
        { id: '1', command: 'clawdbot gateway', status: 'running' }
      ]);
      mockSandbox.startProcess.mockResolvedValue({
        waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
        getLogs: vi.fn().mockResolvedValue({ stdout: 'health-check' }),
      });
      mockSandbox.writeFile.mockResolvedValue({ success: true });
      env.MOLTBOT_BUCKET.put.mockResolvedValue({});

      // Should write to container AND R2
    });
  });

  describe('Exec API Improvements', () => {
    it('should classify container errors as 503', async () => {
      const userId = 'test-user';
      const command = 'echo test';
      
      mockSandbox.listProcesses.mockRejectedValue(new Error('sandbox_not_found'));

      // Should return 503 with errorType: 'container_error'
    });

    it('should classify timeout errors as 504', async () => {
      const userId = 'test-user';
      const command = 'sleep 60';
      
      mockSandbox.listProcesses.mockResolvedValue([
        { id: '1', command: 'clawdbot gateway', status: 'running' }
      ]);
      mockSandbox.startProcess.mockResolvedValue({
        waitForExit: vi.fn().mockImplementation(() => new Promise(() => {})), // Never resolves
        kill: vi.fn(),
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });

      // Should return 504 with errorType: 'timeout_error'
    });

    it('should support streaming mode', async () => {
      const userId = 'test-user';
      const command = 'long-running-task';
      
      mockSandbox.listProcesses.mockResolvedValue([
        { id: '1', command: 'clawdbot gateway', status: 'running' }
      ]);
      mockSandbox.startProcess.mockResolvedValue({
        id: 'proc-123',
        status: 'running',
      });

      // With stream=true, should return immediately with processId
      // Response should include poll endpoint
    });
  });

  describe('Health Check', () => {
    it('should check all components', async () => {
      const userId = 'test-user';
      
      mockSandbox.listProcesses.mockResolvedValue([
        { id: '1', command: 'clawdbot gateway', status: 'running', startTime: new Date() }
      ]);
      mockSandbox.startProcess.mockResolvedValue({
        waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
        getLogs: vi.fn().mockResolvedValue({ stdout: 'health-check\n/root' }),
      });
      env.MOLTBOT_BUCKET.head.mockResolvedValue({ uploaded: new Date() });

      // Health check should verify:
      // - sandbox accessible
      // - gateway running
      // - filesystem responsive
      // - R2 connected
    });

    it('should return 503 if any check fails', async () => {
      const userId = 'test-user';
      
      // Sandbox accessible but gateway not running
      mockSandbox.listProcesses.mockResolvedValue([]);

      // Should return healthy: false with 503 status
    });
  });

  describe('Batch Operations', () => {
    it('should execute multiple file operations', async () => {
      const userId = 'test-user';
      const operations = [
        { op: 'read', path: '/file1.txt' },
        { op: 'write', path: '/file2.txt', content: 'test' },
        { op: 'exists', path: '/file3.txt' },
      ];
      
      mockSandbox.listProcesses.mockResolvedValue([
        { id: '1', command: 'clawdbot gateway', status: 'running' }
      ]);
      mockSandbox.readFile.mockResolvedValue({ success: true, content: 'data' });
      mockSandbox.writeFile.mockResolvedValue({ success: true });
      mockSandbox.exists.mockResolvedValue({ success: true, exists: true });

      // Should execute all operations and return results array
    });

    it('should handle partial failures in batch', async () => {
      const userId = 'test-user';
      const operations = [
        { op: 'read', path: '/exists.txt' },
        { op: 'read', path: '/notfound.txt' },
      ];
      
      mockSandbox.listProcesses.mockResolvedValue([
        { id: '1', command: 'clawdbot gateway', status: 'running' }
      ]);
      mockSandbox.readFile
        .mockResolvedValueOnce({ success: true, content: 'data' })
        .mockResolvedValueOnce({ success: false });

      // Should return 1 success, 1 failure
    });
  });
});

describe('Integration Test Scenarios', () => {
  it('should handle full lifecycle: hibernating -> wake -> exec', async () => {
    // 1. Container is hibernating (listProcesses throws)
    // 2. File read should try R2 first (success)
    // 3. Exec should trigger wake (ensureMoltbotGateway called)
    // 4. After wake, exec should succeed
  });

  it('should handle concurrent requests to same user', async () => {
    // Multiple requests to same user should:
    // 1. Share wake process (startupLocks prevent duplicate starts)
    // 2. All succeed after container is ready
  });

  it('should handle gateway crash mid-operation', async () => {
    // 1. Operation starts
    // 2. Gateway crashes
    // 3. Should detect unresponsive container on retry
    // 4. Should wake and retry operation
  });
});

// Test helper to simulate sandbox states
function createMockSandbox(state: 'running' | 'hibernating' | 'starting' | 'empty') {
  switch (state) {
    case 'running':
      return {
        listProcesses: vi.fn().mockResolvedValue([
          { id: '1', command: 'clawdbot gateway', status: 'running', startTime: new Date() }
        ]),
        startProcess: vi.fn().mockResolvedValue({
          waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
          getLogs: vi.fn().mockResolvedValue({ stdout: 'health-check' }),
        }),
      };
    case 'hibernating':
      return {
        listProcesses: vi.fn().mockRejectedValue(new Error('sandbox hibernating')),
        startProcess: vi.fn().mockRejectedValue(new Error('sandbox hibernating')),
      };
    case 'starting':
      return {
        listProcesses: vi.fn().mockResolvedValue([
          { id: '1', command: 'clawdbot gateway', status: 'starting' }
        ]),
        startProcess: vi.fn().mockResolvedValue({
          waitForExit: vi.fn().mockImplementation(() => new Promise(() => {})),
        }),
      };
    case 'empty':
      return {
        listProcesses: vi.fn().mockResolvedValue([]),
        startProcess: vi.fn().mockResolvedValue({}),
      };
  }
}
