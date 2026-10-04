/*
 * Probe: compile the *real* loader.c and use its own derive_key() +
 * aes_gcm_decrypt() to decrypt a fixture that pack_exe.py produced.
 *
 * This is the only test that sees what bcrypt actually answers. The bug it
 * pins is invisible everywhere else: with BCRYPT_AUTHENTICATED_CIPHER_MODE_
 * INFO.dwInfoVersion left at 0, BCryptDecrypt returns STATUS_INVALID_PARAMETER
 * (0xC000000D) — but only on the call that writes output, so the size-query
 * form succeeds and the Python half of the pipeline stays byte-perfect. The
 * build then ships a loader that calls its own payload "damaged or modified".
 *
 * Build (see test_protect.py, which drives this):
 *
 *     gcc -O2 -std=c11 -Wall -I <fixture dir> -o probe loader_probe.c \
 *         -lbcrypt -luser32
 *     probe <fixture dir>
 *
 * Output is "PROBE-OK" on success; anything else is a failure to diagnose.
 */

#define main loader_main_placeholder /* loader.c's entry point, not ours */
#include "loader.c"
#undef main

#include <errno.h>

static uint8_t *slurp(const char *path, size_t *len)
{
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "PROBE-FAIL cannot open %s: %s\n", path, strerror(errno));
        exit(1);
    }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *buf = (uint8_t *)malloc(n > 0 ? (size_t)n : 1);
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) {
        fprintf(stderr, "PROBE-FAIL short read on %s\n", path);
        exit(1);
    }
    fclose(f);
    *len = (size_t)n;
    return buf;
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: probe <fixture dir>\n");
        return 2;
    }

    char path[1024];
    size_t nlen, tlen, clen, plen;

#define LOAD(name, var, lenp)                                                   \
    snprintf(path, sizeof(path), "%s\\%s", argv[1], name);                      \
    uint8_t *var = slurp(path, lenp)

    LOAD("nonce.bin", nonce, &nlen);
    LOAD("tag.bin", tag, &tlen);
    LOAD("cipher.bin", cipher, &clen);
    LOAD("plain.bin", expect, &plen);
#undef LOAD

    if (nlen != NONCE_LEN || tlen != TAG_LEN || clen != plen || plen == 0) {
        fprintf(stderr, "PROBE-FAIL fixture shape nonce=%zu tag=%zu cipher=%zu plain=%zu\n",
                nlen, tlen, clen, plen);
        return 1;
    }

    uint8_t key[KEY_LEN];
    derive_key(key); /* keygen.h -> key, the way the shipped loader does it */

    uint8_t *plain = (uint8_t *)malloc(clen);
    uint32_t outlen = 0;
    int rc = aes_gcm_decrypt(key, nonce, tag, cipher, (uint32_t)clen, plain, &outlen);
    if (rc != 0) {
        fprintf(stderr, "PROBE-FAIL aes_gcm_decrypt returned %d\n", rc);
        return 1;
    }
    if (outlen != (uint32_t)plen || memcmp(plain, expect, plen) != 0) {
        fprintf(stderr, "PROBE-FAIL plaintext differs (outlen=%lu want=%zu)\n",
                (unsigned long)outlen, plen);
        return 1;
    }
    free(plain);

    /* A flipped byte must be refused by the tag, not silently "decrypted". */
    cipher[clen / 2] ^= 0x01;
    plain = (uint8_t *)malloc(clen);
    outlen = 0;
    rc = aes_gcm_decrypt(key, nonce, tag, cipher, (uint32_t)clen, plain, &outlen);
    free(plain);
    if (rc == 0) {
        fprintf(stderr, "PROBE-FAIL a tampered ciphertext was accepted\n");
        return 1;
    }

    printf("PROBE-OK\n");
    return 0;
}
