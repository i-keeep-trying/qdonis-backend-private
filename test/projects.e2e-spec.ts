import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Role } from '../src/generated/prisma/enums';
import { type MailMessage, MailTransport } from '../src/mail/mail.transport';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObjectStore } from '../src/storage/object-store';
import { StorageSweeperService } from '../src/storage/storage-sweeper.service';
import { MemoryObjectStore } from './helpers/memory-object-store';

class CapturingMail extends MailTransport {
  readonly sent: MailMessage[] = [];
  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
  verify(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {}
}

const PREFIX = '/api/v1';
const PASSWORD = 'correct-horse-battery-1';
const DOMAIN = 'lifecycle.e2e.test';
const run = Date.now().toString(36);
let counter = 0;

interface Session {
  id: string;
  email: string;
  token: string;
}

interface ErrorBody {
  code?: string;
  meta?: Record<string, unknown>;
}

interface StudioNode {
  id: string;
  parentId: string | null;
  stage: string;
  status: string;
  rev: number;
  data: Record<string, unknown>;
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface StudioGraph {
  version: 1;
  nodes: Record<string, StudioNode>;
  branches: Record<string, { id: string; name: string; headId: string | null }>;
  branchOrder: string[];
  activeBranchId: string;
  messages: unknown[];
  initialPrompt?: string;
}

interface ProjectDetail {
  id: string;
  name: string;
  revision: number;
  role: string;
  completedSteps: number;
  totalSteps: number;
  access: { role: string; permissions: Record<string, boolean>; via: string };
  data: Record<string, unknown>;
  studio: StudioGraph;
}

const waitFor = async (check: () => boolean, ms = 3_000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A graph with a ready specs node and a simulation node holding plots. */
function graphWithSimulation(
  base: StudioGraph,
  plots: Record<string, unknown>,
): StudioGraph {
  const t = new Date().toISOString();
  const specs: StudioNode = {
    id: 'n_specs1',
    parentId: null,
    stage: 'specs',
    status: 'ready',
    rev: 1,
    data: {
      rows: [
        {
          id: 'r1',
          name: 'Output voltage',
          value: '12',
          unit: 'V',
          source: 'user',
        },
      ],
    },
    source: 'agent',
    createdAt: t,
    updatedAt: t,
  };
  const sim: StudioNode = {
    id: 'n_sim1',
    parentId: specs.id,
    stage: 'simulation',
    status: 'ready',
    rev: 1,
    data: { results: { vout: 12 }, metadata: { topology: 'dcdc_buck' }, plots },
    source: 'agent',
    createdAt: t,
    updatedAt: t,
  };
  const branch = base.branches[base.activeBranchId];
  return {
    ...base,
    nodes: { [specs.id]: specs, [sim.id]: sim },
    branches: { [branch.id]: { ...branch, headId: sim.id } },
  };
}

describe('Projects, files, sharing, teams, chat (e2e)', () => {
  let app: NestExpressApplication;
  let http: App;
  let prisma: PrismaService;
  const store = new MemoryObjectStore();
  const mail = new CapturingMail();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransport)
      .useValue(mail)
      .overrideProvider(ObjectStore)
      .useValue(store)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      rawBody: true,
    });
    configureApp(app);
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { endsWith: `@${DOMAIN}` } },
    });
    await prisma.user.deleteMany({
      where: { email: { endsWith: '@other.e2e.test' } },
    });
    await app.close();
  });

  async function signUp(
    opts: { verified?: boolean; role?: Role; domain?: string } = {},
  ): Promise<Session> {
    const email = `lc-${run}-${++counter}@${opts.domain ?? DOMAIN}`;
    await request(http)
      .post(`${PREFIX}/auth/register`)
      .send({ email, password: PASSWORD })
      .expect(201);
    const row = await prisma.user.update({
      where: { email },
      data: { emailVerifiedAt: new Date(), role: opts.role ?? Role.USER },
    });
    const res = await request(http)
      .post(`${PREFIX}/auth/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    if (opts.verified === false) {
      await prisma.user.update({
        where: { id: row.id },
        data: { emailVerifiedAt: null },
      });
    }
    return {
      id: row.id,
      email,
      token: (res.body as { accessToken: string }).accessToken,
    };
  }

  const as = (s: Session) => ({ Authorization: `Bearer ${s.token}` });

  async function createProject(
    owner: Session,
    body: Record<string, unknown> = {},
  ) {
    const res = await request(http)
      .post(`${PREFIX}/projects`)
      .set(as(owner))
      .send(body)
      .expect(201);
    return res.body as ProjectDetail;
  }

  const lastMailTo = (email: string): MailMessage | undefined =>
    [...mail.sent].reverse().find((m) => m.to === email);

  const tokenFrom = (message: MailMessage | undefined): string => {
    const match = /token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '');
    if (!match) throw new Error('no token in email');
    return match[1];
  };

  // --- projects ----------------------------------------------------------------

  it('creates a project with an empty Studio graph and lists it', async () => {
    const owner = await signUp();
    const project = await createProject(owner, {
      prompt: 'A 12 V buck converter',
    });
    expect(project).toMatchObject({
      name: 'My Project',
      role: 'OWNER',
      revision: 0,
      completedSteps: 0,
      totalSteps: 7,
      access: { role: 'OWNER', via: 'ownership' },
    });
    expect(project.studio.version).toBe(1);
    expect(project.studio.initialPrompt).toBe('A 12 V buck converter');
    expect(project.data.userInput).toBe('A 12 V buck converter');

    const list = await request(http)
      .get(`${PREFIX}/projects`)
      .set(as(owner))
      .expect(200);
    expect((list.body as { total: number }).total).toBe(1);

    const stranger = await signUp();
    const hidden = await request(http)
      .get(`${PREFIX}/projects/${project.id}`)
      .set(as(stranger))
      .expect(404);
    expect((hidden.body as ErrorBody).code).toBe('PROJECT_NOT_FOUND');
    await request(http)
      .get(`${PREFIX}/projects/not-a-uuid`)
      .set(as(owner))
      .expect(400);
    await request(http).get(`${PREFIX}/projects`).expect(401);
  });

  it('validates input and rejects joining a team you are not in', async () => {
    const owner = await signUp();
    await request(http)
      .post(`${PREFIX}/projects`)
      .set(as(owner))
      .send({ name: '   ' })
      .expect(400);
    await request(http)
      .post(`${PREFIX}/projects`)
      .set(as(owner))
      .send({ unexpected: true })
      .expect(400);
    const res = await request(http)
      .post(`${PREFIX}/projects`)
      .set(as(owner))
      .send({ teamId: '00000000-0000-4000-8000-000000000000' })
      .expect(404);
    expect((res.body as ErrorBody).code).toBe('TEAM_NOT_FOUND');
  });

  it('saves the Studio graph with optimistic locking and moves plots to storage', async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    const plots = { vout: { x: [0, 1, 2], y: [0, 12, 12] } };
    const graph = graphWithSimulation(project.studio, plots);

    const saved = await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(owner))
      .send({ studio: graph, revision: 0 })
      .expect(200);
    expect(saved.body).toMatchObject({
      revision: 1,
      completedSteps: 2,
      totalSteps: 7,
      storedBlobs: 1,
    });

    const stale = await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(owner))
      .send({ studio: graph, revision: 0 })
      .expect(409);
    expect(stale.body).toMatchObject({
      code: 'REVISION_CONFLICT',
      meta: { currentRevision: 1 },
    });

    const detail = (
      await request(http)
        .get(`${PREFIX}/projects/${project.id}`)
        .set(as(owner))
        .expect(200)
    ).body as ProjectDetail;
    const sim = detail.studio.nodes.n_sim1;
    expect(sim.data.plots).toBeUndefined();
    expect(sim.data.plotsCached).toBe(true);
    expect(detail.data.initialSpecification).toBeTruthy();

    // Unchanged plots are not uploaded again.
    const again = await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(owner))
      .send({ studio: graph, revision: 1 })
      .expect(200);
    expect(again.body).toMatchObject({ revision: 2, storedBlobs: 0 });

    const blob = await request(http)
      .get(`${PREFIX}/projects/${project.id}/blobs/download`)
      .query({ name: 'studio/n_sim1' })
      .set(as(owner))
      .expect(200);
    expect((blob.body as { url: string }).url).toContain('cdn.test');
    const stored = store.keysUnder(`e2e/projects/${project.id}/blobs/`);
    expect(stored).toHaveLength(1);
    expect(
      JSON.parse(store.objects.get(stored[0])!.body.toString('utf8')),
    ).toEqual({ plots });
  });

  it('rejects malformed graphs', async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    const broken = {
      ...project.studio,
      nodes: {
        n_x: {
          id: 'n_x',
          parentId: 'n_missing',
          stage: 'specs',
          status: 'ready',
          rev: 1,
          data: {},
          source: 'agent',
          createdAt: '',
          updatedAt: '',
        },
      },
    };
    const res = await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(owner))
      .send({ studio: broken, revision: 0 })
      .expect(400);
    expect((res.body as ErrorBody).code).toBe('VALIDATION_FAILED');
    await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(owner))
      .send({ studio: { ...project.studio, version: 2 }, revision: 0 })
      .expect(400);
  });

  it('renames, versions, restores and records activity', async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    await request(http)
      .patch(`${PREFIX}/projects/${project.id}`)
      .set(as(owner))
      .send({ name: 'Buck 12V' })
      .expect(200);

    const version = await request(http)
      .post(`${PREFIX}/projects/${project.id}/versions`)
      .set(as(owner))
      .send({ description: 'empty' })
      .expect(201);
    const graph = graphWithSimulation(project.studio, { a: [1] });
    await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(owner))
      .send({ studio: graph, revision: 0 })
      .expect(200);
    const restored = await request(http)
      .post(
        `${PREFIX}/projects/${project.id}/versions/${(version.body as { id: string }).id}/restore`,
      )
      .set(as(owner))
      .expect(200);
    expect(restored.body).toMatchObject({ revision: 2, completedSteps: 0 });

    const feed = await request(http)
      .get(`${PREFIX}/projects/${project.id}/activity`)
      .set(as(owner))
      .expect(200);
    const actions = (
      feed.body as { items: Array<{ action: string }> }
    ).items.map((i) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining(['created the project', 'renamed to "Buck 12V"']),
    );
  });

  it('duplicates a project with its files, then deletes and sweeps storage', async () => {
    const owner = await signUp();
    const project = await createProject(owner, { name: 'Original' });
    await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(owner))
      .send({
        studio: graphWithSimulation(project.studio, { p: [1, 2] }),
        revision: 0,
      })
      .expect(200);

    const copy = (
      await request(http)
        .post(`${PREFIX}/projects/${project.id}/duplicate`)
        .set(as(owner))
        .send({})
        .expect(201)
    ).body as ProjectDetail;
    expect(copy.name).toBe('Original - copy');
    expect(copy.studio.nodes.n_sim1).toBeDefined();
    expect(store.keysUnder(`e2e/projects/${copy.id}/blobs/`)).toHaveLength(1);

    await request(http)
      .delete(`${PREFIX}/projects/${copy.id}`)
      .set(as(owner))
      .expect(200);
    await request(http)
      .get(`${PREFIX}/projects/${copy.id}`)
      .set(as(owner))
      .expect(404);
    const queued = await prisma.storageDeletion.count({
      where: { key: { startsWith: `e2e/projects/${copy.id}/` } },
    });
    expect(queued).toBe(1);

    store.failDeletes = true;
    const failed = await app.get(StorageSweeperService).run();
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    store.failDeletes = false;
    await prisma.storageDeletion.updateMany({
      data: { notBefore: new Date(0) },
    });
    await app.get(StorageSweeperService).run();
    expect(store.keysUnder(`e2e/projects/${copy.id}/`)).toHaveLength(0);
    expect(store.keysUnder(`e2e/projects/${project.id}/`)).toHaveLength(1);
  });

  // --- files -------------------------------------------------------------------

  it('uploads documents with server-side text extraction and type checks', async () => {
    const owner = await signUp();
    const doc = await request(http)
      .post(`${PREFIX}/files/documents`)
      .set(as(owner))
      .attach(
        'file',
        Buffer.from('\uFEFFInput 24 V, output 12 V at 5 A'),
        'spec.txt',
      )
      .expect(201);
    expect(doc.body).toMatchObject({
      kind: 'DOCUMENT',
      hasText: true,
      text: 'Input 24 V, output 12 V at 5 A',
    });

    const pdf = await request(http)
      .post(`${PREFIX}/files/documents`)
      .set(as(owner))
      .attach('file', Buffer.from('%PDF-1.7 fake'), 'spec.pdf')
      .expect(201);
    expect(pdf.body).toMatchObject({
      contentType: 'application/pdf',
      hasText: false,
      text: null,
    });

    const spoofed = await request(http)
      .post(`${PREFIX}/files/documents`)
      .set(as(owner))
      .attach('file', Buffer.from('MZ binary'), 'spec.pdf')
      .expect(400);
    expect((spoofed.body as ErrorBody).code).toBe('UNSUPPORTED_FILE_TYPE');
    await request(http)
      .post(`${PREFIX}/files/documents`)
      .set(as(owner))
      .attach('file', Buffer.from('x'), 'spec.exe')
      .expect(400);
    await request(http)
      .post(`${PREFIX}/files/documents`)
      .set(as(owner))
      .attach('file', Buffer.from('   '), 'blank.txt')
      .expect(400);
    await request(http)
      .post(`${PREFIX}/files/documents`)
      .set(as(owner))
      .expect(400);
    await request(http)
      .post(`${PREFIX}/files/documents`)
      .set(as(owner))
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61), 'big.txt')
      .expect(413);

    const other = await signUp();
    await request(http)
      .get(`${PREFIX}/files/documents/${(doc.body as { id: string }).id}`)
      .set(as(other))
      .expect(404);
    const list = await request(http)
      .get(`${PREFIX}/files/documents`)
      .set(as(owner))
      .expect(200);
    expect((list.body as { total: number }).total).toBe(2);
  });

  it('runs the presigned upload flow for stage blobs', async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    const body = Buffer.from(JSON.stringify({ waveform: [1, 2, 3] }));

    const ticket = await request(http)
      .post(`${PREFIX}/projects/${project.id}/blobs/uploads`)
      .set(as(owner))
      .send({
        name: 'studio/n_wave',
        contentType: 'application/json',
        sizeBytes: body.length,
      })
      .expect(201);
    const fileId = (ticket.body as { file: { id: string } }).file.id;

    const early = await request(http)
      .post(`${PREFIX}/projects/${project.id}/blobs/uploads/${fileId}/complete`)
      .set(as(owner))
      .expect(409);
    expect((early.body as ErrorBody).code).toBe('UPLOAD_INCOMPLETE');

    store.simulateUpload(store.uploadKeys.at(-1)!, body, 'application/json');
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/blobs/uploads/${fileId}/complete`)
      .set(as(owner))
      .expect(200);
    await request(http)
      .get(`${PREFIX}/projects/${project.id}/blobs/download`)
      .query({ name: 'studio/n_wave' })
      .set(as(owner))
      .expect(200);

    await request(http)
      .post(`${PREFIX}/projects/${project.id}/blobs/uploads`)
      .set(as(owner))
      .send({
        name: '../etc/passwd',
        contentType: 'application/json',
        sizeBytes: 10,
      })
      .expect(400);
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/blobs/uploads`)
      .set(as(owner))
      .send({ name: 'studio/x', contentType: 'text/html', sizeBytes: 10 })
      .expect(400);
  });

  // --- sharing -----------------------------------------------------------------

  it('shares with registered users and enforces roles', async () => {
    const owner = await signUp();
    const viewer = await signUp();
    const editor = await signUp();
    const project = await createProject(owner);

    const res = await request(http)
      .post(`${PREFIX}/projects/${project.id}/invitations`)
      .set(as(owner))
      .send({
        emails: [viewer.email.toUpperCase(), owner.email],
        role: 'VIEWER',
      })
      .expect(201);
    expect(
      (res.body as { results: Array<{ status: string }> }).results.map(
        (r) => r.status,
      ),
    ).toEqual(['shared', 'failed']);
    await waitFor(() => Boolean(lastMailTo(viewer.email)));

    const asViewer = (
      await request(http)
        .get(`${PREFIX}/projects/${project.id}`)
        .set(as(viewer))
        .expect(200)
    ).body as ProjectDetail;
    expect(asViewer.access).toMatchObject({
      role: 'VIEWER',
      via: 'direct_share',
    });
    const readOnly = await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(viewer))
      .send({ studio: asViewer.studio, revision: asViewer.revision })
      .expect(403);
    expect((readOnly.body as ErrorBody).code).toBe('PROJECT_READ_ONLY');
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/invitations`)
      .set(as(viewer))
      .send({ emails: [editor.email], role: 'EDITOR' })
      .expect(403);

    const shared = await request(http)
      .get(`${PREFIX}/projects`)
      .query({ scope: 'shared' })
      .set(as(viewer))
      .expect(200);
    expect(
      (shared.body as { items: Array<{ id: string; role: string }> }).items,
    ).toEqual([expect.objectContaining({ id: project.id, role: 'VIEWER' })]);

    // Admins can share but cannot mint other admins.
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/invitations`)
      .set(as(owner))
      .send({ emails: [editor.email], role: 'ADMIN' })
      .expect(201);
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/invitations`)
      .set(as(editor))
      .send({ emails: [viewer.email], role: 'ADMIN' })
      .expect(403);

    const collaborators = await request(http)
      .get(`${PREFIX}/projects/${project.id}/collaborators`)
      .set(as(viewer))
      .expect(200);
    const view = collaborators.body as {
      collaborators: Array<{ id: string; user: { id: string }; role: string }>;
      activeLinks: unknown[];
    };
    expect(view.collaborators).toHaveLength(2);
    expect(view.activeLinks).toEqual([]);

    const viewerMember = view.collaborators.find(
      (c) => c.user.id === viewer.id,
    )!;
    const editorMember = view.collaborators.find(
      (c) => c.user.id === editor.id,
    )!;
    await request(http)
      .patch(`${PREFIX}/projects/${project.id}/members/${viewerMember.id}`)
      .set(as(editor))
      .send({ role: 'EDITOR' })
      .expect(200);
    await request(http)
      .delete(`${PREFIX}/projects/${project.id}/members/${editorMember.id}`)
      .set(as(viewer))
      .expect(403);
    // Leaving through "delete project" as a collaborator.
    const left = await request(http)
      .delete(`${PREFIX}/projects/${project.id}`)
      .set(as(viewer))
      .expect(200);
    expect(left.body).toEqual({ deleted: false, left: true });
    await request(http)
      .get(`${PREFIX}/projects/${project.id}`)
      .set(as(viewer))
      .expect(404);
  });

  it('invites new users by email and accepts with matching, verified email only', async () => {
    const owner = await signUp();
    const project = await createProject(owner, { name: 'Invite me' });
    const inviteeEmail = `lc-${run}-${++counter}@${DOMAIN}`;
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/invitations`)
      .set(as(owner))
      .send({ emails: [inviteeEmail], role: 'EDITOR', message: 'Join me' })
      .expect(201);
    await waitFor(() => Boolean(lastMailTo(inviteeEmail)));
    const token = tokenFrom(lastMailTo(inviteeEmail));

    const preview = await request(http)
      .get(`${PREFIX}/invitations/${token}`)
      .expect(200);
    expect(preview.body).toMatchObject({
      projectName: 'Invite me',
      role: 'EDITOR',
      email: inviteeEmail,
    });
    await request(http)
      .get(`${PREFIX}/invitations/not-a-real-token-at-all`)
      .expect(404);

    const wrongPerson = await signUp();
    const mismatch = await request(http)
      .post(`${PREFIX}/invitations/${token}/accept`)
      .set(as(wrongPerson))
      .expect(403);
    expect((mismatch.body as ErrorBody).code).toBe('INVITATION_EMAIL_MISMATCH');

    await request(http)
      .post(`${PREFIX}/auth/register`)
      .send({ email: inviteeEmail, password: PASSWORD })
      .expect(201);
    await prisma.user.update({
      where: { email: inviteeEmail },
      data: { emailVerifiedAt: new Date() },
    });
    const login = await request(http)
      .post(`${PREFIX}/auth/login`)
      .send({ email: inviteeEmail, password: PASSWORD })
      .expect(200);
    const invitee: Session = {
      id: '',
      email: inviteeEmail,
      token: (login.body as { accessToken: string }).accessToken,
    };
    const accepted = await request(http)
      .post(`${PREFIX}/invitations/${token}/accept`)
      .set(as(invitee))
      .expect(200);
    expect(accepted.body).toMatchObject({
      projectId: project.id,
      role: 'EDITOR',
    });
    // Idempotent for the same user, closed for everyone else.
    await request(http)
      .post(`${PREFIX}/invitations/${token}/accept`)
      .set(as(invitee))
      .expect(200);
    await request(http).get(`${PREFIX}/invitations/${token}`).expect(409);
  });

  it('share links: password, one-time use, domain restriction, deactivation', async () => {
    const owner = await signUp();
    const project = await createProject(owner);

    await request(http)
      .post(`${PREFIX}/projects/${project.id}/share-links`)
      .set(as(owner))
      .send({ type: 'PASSWORD_PROTECTED', role: 'VIEWER' })
      .expect(400);
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/share-links`)
      .set(as(owner))
      .send({ type: 'ANYONE_WITH_LINK', role: 'ADMIN' })
      .expect(400);
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/share-links`)
      .set(as(owner))
      .send({
        type: 'ANYONE_WITH_LINK',
        role: 'VIEWER',
        expiresAt: '2001-01-01T00:00:00Z',
      })
      .expect(400);

    const protectedLink = await request(http)
      .post(`${PREFIX}/projects/${project.id}/share-links`)
      .set(as(owner))
      .send({
        type: 'PASSWORD_PROTECTED',
        role: 'EDITOR',
        password: 'open-sesame-9',
      })
      .expect(201);
    const pwToken = (protectedLink.body as { url: string }).url.split(
      '/share/',
    )[1];
    expect((protectedLink.body as { hasPassword: boolean }).hasPassword).toBe(
      true,
    );
    const row = await prisma.shareLink.findUnique({
      where: { token: pwToken },
    });
    expect(row?.passwordHash?.startsWith('$argon2id$')).toBe(true);

    const preview = await request(http)
      .get(`${PREFIX}/share-links/${pwToken}`)
      .expect(200);
    expect(preview.body).toMatchObject({
      requiresPassword: true,
      role: 'EDITOR',
    });

    const guest = await signUp();
    const noPassword = await request(http)
      .post(`${PREFIX}/share-links/${pwToken}/access`)
      .set(as(guest))
      .send({})
      .expect(403);
    expect((noPassword.body as ErrorBody).code).toBe(
      'SHARE_LINK_PASSWORD_REQUIRED',
    );
    await request(http)
      .post(`${PREFIX}/share-links/${pwToken}/access`)
      .set(as(guest))
      .send({ password: 'wrong-password' })
      .expect(403);
    await request(http)
      .post(`${PREFIX}/share-links/${pwToken}/access`)
      .set(as(guest))
      .send({ password: 'open-sesame-9' })
      .expect(200);
    const access = await request(http)
      .get(`${PREFIX}/projects/${project.id}/access`)
      .set(as(guest))
      .expect(200);
    expect(access.body).toMatchObject({ role: 'EDITOR', via: 'link_share' });

    const oneTime = await request(http)
      .post(`${PREFIX}/projects/${project.id}/share-links`)
      .set(as(owner))
      .send({ type: 'ONE_TIME_USE', role: 'VIEWER' })
      .expect(201);
    const otToken = (oneTime.body as { url: string }).url.split('/share/')[1];
    const first = await signUp();
    const second = await signUp();
    const [a, b] = await Promise.all([
      request(http)
        .post(`${PREFIX}/share-links/${otToken}/access`)
        .set(as(first))
        .send({}),
      request(http)
        .post(`${PREFIX}/share-links/${otToken}/access`)
        .set(as(second))
        .send({}),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);

    const domainLink = await request(http)
      .post(`${PREFIX}/projects/${project.id}/share-links`)
      .set(as(owner))
      .send({
        type: 'DOMAIN_RESTRICTED',
        role: 'VIEWER',
        allowedDomains: [`@${DOMAIN.toUpperCase()}`],
      })
      .expect(201);
    const domainToken = (domainLink.body as { url: string }).url.split(
      '/share/',
    )[1];
    const outsider = await signUp({ domain: 'other.e2e.test' });
    const blocked = await request(http)
      .post(`${PREFIX}/share-links/${domainToken}/access`)
      .set(as(outsider))
      .send({})
      .expect(403);
    expect((blocked.body as ErrorBody).code).toBe(
      'SHARE_LINK_DOMAIN_RESTRICTED',
    );
    const insider = await signUp();
    await request(http)
      .post(`${PREFIX}/share-links/${domainToken}/access`)
      .set(as(insider))
      .send({})
      .expect(200);

    const linkId = (domainLink.body as { id: string }).id;
    await request(http)
      .delete(`${PREFIX}/projects/${project.id}/share-links/${linkId}`)
      .set(as(owner))
      .expect(204);
    const inactive = await request(http)
      .get(`${PREFIX}/share-links/${domainToken}`)
      .expect(400);
    expect((inactive.body as ErrorBody).code).toBe('SHARE_LINK_INACTIVE');
    // Existing collaborators keep access after a link is deactivated.
    await request(http)
      .get(`${PREFIX}/projects/${project.id}`)
      .set(as(insider))
      .expect(200);
  });

  // --- teams -------------------------------------------------------------------

  it('teams: plan gate, invitations, team projects and roles', async () => {
    const owner = await signUp();
    const noPlan = await request(http)
      .post(`${PREFIX}/teams`)
      .set(as(owner))
      .send({ name: 'Power' })
      .expect(402);
    expect((noPlan.body as ErrorBody).code).toBe('TEAM_PLAN_REQUIRED');

    const admin = await signUp({ role: Role.ADMIN });
    await request(http)
      .post(`${PREFIX}/admin/users/${owner.id}/plan`)
      .set(as(admin))
      .send({ planId: 'teams', interval: 'MONTHLY', tokenAllocation: 750000 })
      .expect(201);

    const tooMuch = await request(http)
      .post(`${PREFIX}/teams`)
      .set(as(owner))
      .send({ name: 'Power', tokenLimit: 99_000_000 })
      .expect(400);
    expect((tooMuch.body as ErrorBody).code).toBe('TEAM_TOKEN_LIMIT_INVALID');
    const team = (
      await request(http)
        .post(`${PREFIX}/teams`)
        .set(as(owner))
        .send({ name: 'Power', tokenLimit: 100_000 })
        .expect(201)
    ).body as { id: string; role: string; memberCount: number };
    expect(team).toMatchObject({ role: 'OWNER', memberCount: 1 });

    const member = await signUp();
    await request(http)
      .post(`${PREFIX}/teams/${team.id}/invitations`)
      .set(as(owner))
      .send({ email: member.email })
      .expect(201);
    await request(http)
      .post(`${PREFIX}/teams/${team.id}/invitations`)
      .set(as(owner))
      .send({ email: member.email })
      .expect(409);
    await waitFor(() => Boolean(lastMailTo(member.email)));
    const token = tokenFrom(lastMailTo(member.email));
    const mine = await request(http)
      .get(`${PREFIX}/teams/invitations/mine`)
      .set(as(member))
      .expect(200);
    expect(mine.body).toHaveLength(1);
    await request(http)
      .post(`${PREFIX}/teams/invitations/${token}/accept`)
      .set(as(member))
      .expect(200);
    await request(http)
      .post(`${PREFIX}/teams/invitations/${token}/accept`)
      .set(as(member))
      .expect(409);

    const project = await createProject(owner, {
      name: 'Team project',
      teamId: team.id,
    });
    const asMember = await request(http)
      .get(`${PREFIX}/projects/${project.id}`)
      .set(as(member))
      .expect(200);
    expect((asMember.body as ProjectDetail).access).toMatchObject({
      role: 'EDITOR',
      via: 'team',
    });
    const teamList = await request(http)
      .get(`${PREFIX}/projects`)
      .query({ scope: 'team', teamId: team.id })
      .set(as(member))
      .expect(200);
    expect((teamList.body as { total: number }).total).toBe(1);

    await request(http)
      .post(`${PREFIX}/teams/${team.id}/invitations`)
      .set(as(member))
      .send({ email: `x-${run}@${DOMAIN}` })
      .expect(403);
    await request(http)
      .delete(`${PREFIX}/teams/${team.id}/members/${owner.id}`)
      .set(as(owner))
      .expect(403);
    const summary = await request(http)
      .get(`${PREFIX}/teams/${team.id}/tokens`)
      .set(as(member))
      .expect(200);
    expect(summary.body).toMatchObject({
      tokenLimit: 100000,
      tokensUsed: 0,
      ownerPlanActive: true,
    });

    await request(http)
      .delete(`${PREFIX}/teams/${team.id}/members/${member.id}`)
      .set(as(member))
      .expect(204);
    await request(http)
      .get(`${PREFIX}/projects/${project.id}`)
      .set(as(member))
      .expect(404);

    await request(http)
      .delete(`${PREFIX}/teams/${team.id}`)
      .set(as(owner))
      .expect(204);
    const personal = await request(http)
      .get(`${PREFIX}/projects/${project.id}`)
      .set(as(owner))
      .expect(200);
    expect((personal.body as { teamId: string | null }).teamId).toBeNull();
  });

  // --- admin + chat ------------------------------------------------------------

  it('platform admins see every project read-only', async () => {
    const owner = await signUp();
    const project = await createProject(owner, {
      name: `Admin-visible ${run}`,
    });
    const admin = await signUp({ role: Role.ADMIN });
    const list = await request(http)
      .get(`${PREFIX}/admin/projects`)
      .query({ search: `Admin-visible ${run}` })
      .set(as(admin))
      .expect(200);
    expect((list.body as { total: number }).total).toBe(1);
    const view = await request(http)
      .get(`${PREFIX}/projects/${project.id}`)
      .set(as(admin))
      .expect(200);
    expect((view.body as ProjectDetail).access).toMatchObject({
      role: 'VIEWER',
      via: 'platform_admin',
    });
    await request(http)
      .get(`${PREFIX}/admin/projects`)
      .set(as(owner))
      .expect(403);
  });

  it('keeps chat history private per user', async () => {
    const owner = await signUp();
    const viewer = await signUp();
    const project = await createProject(owner);
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/invitations`)
      .set(as(owner))
      .send({ emails: [viewer.email], role: 'VIEWER' })
      .expect(201);
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/chat`)
      .set(as(owner))
      .send({ sender: 'USER', content: 'hello' })
      .expect(201);
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/chat`)
      .set(as(viewer))
      .send({ sender: 'USER', content: 'mine' })
      .expect(201);
    const ownerChat = await request(http)
      .get(`${PREFIX}/projects/${project.id}/chat`)
      .set(as(owner))
      .expect(200);
    expect(
      (ownerChat.body as { items: Array<{ content: string }> }).items.map(
        (m) => m.content,
      ),
    ).toEqual(['hello']);
    const cleared = await request(http)
      .delete(`${PREFIX}/projects/${project.id}/chat`)
      .set(as(owner))
      .expect(200);
    expect(cleared.body).toEqual({ deleted: 1 });
    const stranger = await signUp();
    await request(http)
      .get(`${PREFIX}/projects/${project.id}/chat`)
      .set(as(stranger))
      .expect(404);
  });
});
