import type { ApiResponse } from './types'

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      signal: options.signal ?? AbortSignal.timeout(15_000),
    })
    const result = await response.json() as ApiResponse<T>
    if (!response.ok || !result.success) throw new Error(result.message || 'Request gagal. Coba lagi.')
    return result.data
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Server tidak terhubung. Pastikan bun run dev sedang berjalan.')
    throw error
  }
}
