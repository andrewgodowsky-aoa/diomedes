export function verifyNativePublisher(file: string,
  readSignature?: (file: string) => Promise<{ status: string; subject: string | null }>): Promise<void>;
