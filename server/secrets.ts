import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

export class AccountSecrets {
  private keyFile?: string
  private loadedKey?: Buffer

  constructor(keyFile?: string) { this.keyFile = keyFile }

  private key(create: boolean) {
    if (this.loadedKey) return this.loadedKey
    if (!this.keyFile) return this.loadedKey = randomBytes(32)
    try {
      const key = readFileSync(this.keyFile)
      if (key.length !== 32) throw new Error('账户密钥格式无效')
      return this.loadedKey = key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) throw new Error('本地账户密钥缺失')
      const key = randomBytes(32)
      writeFileSync(this.keyFile, key, { flag: 'wx', mode: 0o600 })
      return this.loadedKey = key
    }
  }

  seal(password: string, binding: string, createKey: boolean) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key(createKey), iv)
    cipher.setAAD(Buffer.from(binding))
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
  }

  open(sealed: string, binding: string) {
    const encoded = Buffer.from(sealed, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', this.key(false), encoded.subarray(0, 12))
    decipher.setAAD(Buffer.from(binding))
    decipher.setAuthTag(encoded.subarray(12, 28))
    return Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString('utf8')
  }
}
