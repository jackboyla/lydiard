# Local config

The real `config/` directory is gitignored. Nothing in it is ever committed — it holds
deployment-specific material that would only widen the attack surface of a public repo.

Create it yourself:

```bash
mkdir -p config && chmod 700 config
```

## `config/lydiard-backup-public.asc`

The OpenPGP **public** key that `npm run backup:d1` encrypts each D1 export with. Generate a
keypair once, keeping the private half offline:

```bash
gpg --quick-generate-key 'Lydiard Backup <you@example.com>' rsa4096 encr never
gpg --armor --export 'Lydiard Backup' > config/lydiard-backup-public.asc
```

Export the private key and its passphrase to a password manager or offline store. Do not put
either in GitHub, Drive, or Cloudflare — they are the only way to read a backup.

CI does not use this file. The workflow passes the same armored key through the
`LYDIARD_BACKUP_PUBLIC_KEY` secret instead:

```bash
gh secret set LYDIARD_BACKUP_PUBLIC_KEY < config/lydiard-backup-public.asc
```

## Restore-side settings

`npm run backup:verify` needs the private key. It reads, in order of preference:

| Variable | Default |
| --- | --- |
| `LYDIARD_BACKUP_DIR` | `~/.config/lydiard-backup` |
| `LYDIARD_BACKUP_GNUPGHOME` | `$LYDIARD_BACKUP_DIR/gnupg` |
| `LYDIARD_BACKUP_PASSPHRASE_FILE` | `$LYDIARD_BACKUP_DIR/recovery-passphrase.txt` |

Keep that directory outside the repository and readable only by you (`chmod 700`).
