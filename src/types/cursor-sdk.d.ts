declare module '@cursor/sdk' {
  export const Agent: {
    prompt(
      message: string,
      options: {
        apiKey: string;
        model: { id: string };
        mode?: 'agent' | 'plan';
        local?: { cwd: string };
      }
    ): Promise<{ status: string; result?: string }>;
  };
}
