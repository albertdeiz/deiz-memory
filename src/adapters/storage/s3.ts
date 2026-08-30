import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { BlobStore } from '../../core/ports.js';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function s3BlobStore(cfg: S3Config): BlobStore {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // Garage habla S3 en path style. Es también lo que hace que cambiar a R2
    // sea un cambio de variables de entorno y nada más.
    forcePathStyle: true,
  });

  const notFound = (e: unknown): boolean => {
    const name = (e as { name?: string; $metadata?: { httpStatusCode?: number } })?.name;
    const code = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    return name === 'NotFound' || name === 'NoSuchKey' || code === 404;
  };

  return {
    async put(key, bytes, mediaType) {
      await client.send(
        new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: bytes, ContentType: mediaType }),
      );
    },

    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return true;
      } catch (e) {
        if (notFound(e)) return false;
        throw e;
      }
    },

    async healthy() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
