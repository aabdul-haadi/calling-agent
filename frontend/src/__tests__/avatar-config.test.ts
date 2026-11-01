import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clientConfigSchema } from '@adk/shared';
import { skylinkAir } from '../../../clients/skylink-air/client.config';
import { novatel } from '../../../clients/novatel/client.config';
import { AVATARS, avatarFor } from '@/avatar/avatar-config';
import { VISEMES } from '@/avatar/lip-sync';

const publicDir = resolve(__dirname, '../../public');

/** The VRM meta block embedded in a .vrm (a GLB) file. */
function vrmMeta(url: string): Record<string, unknown> {
  const file = readFileSync(resolve(publicDir, url.replace(/^\//, '')));
  const jsonLength = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString('utf8')) as {
    extensions: Record<string, { meta: Record<string, unknown>; expressions?: { preset: object } }>;
  };
  return json.extensions['VRMC_vrm']!.meta;
}
function vrmExpressions(url: string): string[] {
  const file = readFileSync(resolve(publicDir, url.replace(/^\//, '')));
  const jsonLength = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString('utf8')) as {
    extensions: Record<string, { expressions: { preset: object } }>;
  };
  return Object.keys(json.extensions['VRMC_vrm']!.expressions.preset);
}

describe('avatar configuration', () => {
  it('Ava belongs to SkyLink Air and matches the tenant persona', () => {
    const tenant = clientConfigSchema.parse(skylinkAir);
    const ava = avatarFor('skylink-air')!;
    expect(ava.name).toBe(tenant.persona.name);
    expect(ava.clientId).toBe(tenant.id);
    expect(ava.modelUrl).toBe('/avatars/ava.vrm');
    expect(ava.theme.background).toContain('#');
  });

  it('Nia belongs to NovaTel and matches the tenant persona', () => {
    const tenant = clientConfigSchema.parse(novatel);
    const nia = avatarFor('novatel')!;
    expect(nia.name).toBe(tenant.persona.name);
    expect(nia.clientId).toBe(tenant.id);
    expect(nia.modelUrl).toBe('/avatars/nia.vrm');
  });

  it('the two characters are distinct (model, look and framing are separate configuration)', () => {
    const ava = avatarFor('skylink-air')!;
    const nia = avatarFor('novatel')!;
    expect(ava.modelUrl).not.toBe(nia.modelUrl);
    expect(ava.theme.rim).not.toBe(nia.theme.rim);
    expect(ava.theme.background).not.toBe(nia.theme.background);
  });

  it('an unknown tenant has no avatar, so the caller shows the plain status orb', () => {
    expect(avatarFor('someone-else')).toBeUndefined();
  });

  it('every configured model file exists and is a VRM 1.0 model with the expressions the engine drives', () => {
    for (const cfg of Object.values(AVATARS)) {
      const path = resolve(publicDir, cfg.modelUrl.replace(/^\//, ''));
      expect(existsSync(path), cfg.modelUrl).toBe(true);
      expect(readFileSync(path).subarray(0, 4).toString('latin1')).toBe('glTF');
      const expressions = vrmExpressions(cfg.modelUrl);
      for (const v of VISEMES) expect(expressions, `${cfg.name} ${v}`).toContain(cfg.visemeMap[v]);
      expect(expressions).toContain(cfg.blinkExpression);
    }
  });

  it('the licence embedded in each model allows commercial use, redistribution and modification', () => {
    for (const cfg of Object.values(AVATARS)) {
      const meta = vrmMeta(cfg.modelUrl);
      expect(meta['commercialUsage'], cfg.name).toBe('corporation');
      expect(meta['allowRedistribution'], cfg.name).toBe(true);
      expect(meta['modification'], cfg.name).toBe('allowModificationRedistribution');
      // a model whose licence asks for credit must show it
      if (meta['creditNotation'] === 'required') expect(cfg.credit, cfg.name).toBeDefined();
    }
  });

  it('the licence table ships next to the models', () => {
    const text = readFileSync(resolve(publicDir, 'avatars/LICENSES.md'), 'utf8');
    expect(text).toContain('ava.vrm');
    expect(text).toContain('nia.vrm');
    expect(text).toContain('VirtualCast');
  });
});
