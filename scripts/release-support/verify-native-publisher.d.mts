export interface NativeSignature { status: string; subject: string | null }
export function verifyNativePublisher(file: string,
  readSignature?: (file: string) => Promise<NativeSignature>): Promise<void>;
export function verifyNativePublishers(files: string[],
  readSignatures?: (files: string[]) => Promise<NativeSignature[]>): Promise<void>;
