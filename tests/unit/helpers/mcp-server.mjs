// A tiny stdio MCP server used by the tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'test-server', version: '1.2.3' })
server.tool('add', 'Add two numbers', { a: z.number(), b: z.number() }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }))
server.tool('fail', 'Always fails', {}, async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }))
server.resource('greeting', 'test://greeting', async uri => ({ contents: [{ uri: uri.href, text: 'hello from resource' }] }))
await server.connect(new StdioServerTransport())
