import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { Prisma } from '../src/generated/prisma/client';
import { type MailMessage, MailTransport } from '../src/mail/mail.transport';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObjectStore } from '../src/storage/object-store';
import { MemoryObjectStore } from './helpers/memory-object-store';

class SilentMail extends MailTransport {
  send(_message: MailMessage): Promise<void> {
    return Promise.resolve();
  }
  verify(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {}
}

const PREFIX = '/api/v1';
const PASSWORD = 'correct-horse-battery-1';
const DOMAIN = 'branches.e2e.test';
const run = Date.now().toString(36);
let counter = 0;

interface Session {
  id: string;
  email: string;
  token: string;
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
  branches: Record<
    string,
    {
      id: string;
      name: string;
      headId: string | null;
      forkedFromId: string | null;
      createdAt: string;
      colorIndex: number;
    }
  >;
  branchOrder: string[];
  activeBranchId: string;
  messages: unknown[];
  initialPrompt?: string;
}

interface ProjectDetail {
  id: string;
  revision: number;
  data: Record<string, unknown>;
  studio: StudioGraph;
}

interface BranchView {
  id: string;
  name: string;
  headId: string | null;
  parentBranchId: string | null;
  depth: number;
  ownStages: string[];
}

interface Workspace {
  activeBranchId: string;
  readOnly: boolean;
  version: number;
  branches: BranchView[];
  stages: Record<string, { status: string; nodeId: string | null }>;
}

interface ErrorBody {
  code?: string;
}

const node = (
  id: string,
  stage: string,
  parentId: string | null,
  at: string,
): StudioNode => ({
  id,
  parentId,
  stage,
  status: 'ready',
  rev: 1,
  data: { note: id },
  source: 'agent',
  createdAt: at,
  updatedAt: at,
});

describe('Studio branches stored in tables (e2e)', () => {
  let app: NestExpressApplication;
  let http: App;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransport)
      .useValue(new SilentMail())
      .overrideProvider(ObjectStore)
      .useValue(new MemoryObjectStore())
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
    await app.close();
  });

  async function signUp(): Promise<Session> {
    const email = `br-${run}-${++counter}@${DOMAIN}`;
    await request(http)
      .post(`${PREFIX}/auth/register`)
      .send({ email, password: PASSWORD })
      .expect(201);
    const row = await prisma.user.update({
      where: { email },
      data: { emailVerifiedAt: new Date() },
    });
    const res = await request(http)
      .post(`${PREFIX}/auth/login`)
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      id: row.id,
      email,
      token: (res.body as { accessToken: string }).accessToken,
    };
  }

  const as = (s: Session) => ({ Authorization: `Bearer ${s.token}` });

  const detail = async (s: Session, id: string) =>
    (await request(http).get(`${PREFIX}/projects/${id}`).set(as(s)).expect(200))
      .body as ProjectDetail;

  const workspace = async (s: Session, id: string) =>
    (
      await request(http)
        .get(`${PREFIX}/projects/${id}/studio`)
        .set(as(s))
        .expect(200)
    ).body as Workspace;

  const createProject = async (s: Session, prompt = 'A 12 V buck') =>
    (
      await request(http)
        .post(`${PREFIX}/projects`)
        .set(as(s))
        .send({ prompt })
        .expect(201)
    ).body as ProjectDetail;

  /** Saves specs -> design on the first branch. */
  async function seedGraph(s: Session, projectId: string) {
    const current = await detail(s, projectId);
    const t0 = new Date(Date.now() - 2_000).toISOString();
    const t1 = new Date(Date.now() - 1_000).toISOString();
    const main = current.studio.branchOrder[0];
    const studio: StudioGraph = {
      ...current.studio,
      nodes: {
        n_specs: node('n_specs', 'specs', null, t0),
        n_design: node('n_design', 'design', 'n_specs', t1),
      },
      branches: {
        [main]: { ...current.studio.branches[main], headId: 'n_design' },
      },
    };
    await request(http)
      .put(`${PREFIX}/projects/${projectId}/studio`)
      .set(as(s))
      .send({ studio, revision: current.revision })
      .expect(200);
    return main;
  }

  const createBranch = (
    s: Session,
    projectId: string,
    body: Record<string, unknown>,
  ) =>
    request(http)
      .post(`${PREFIX}/projects/${projectId}/branches`)
      .set(as(s))
      .send(body);

  it('creates a project with one branch stored in tables', async () => {
    const owner = await signUp();
    const project = await createProject(owner);

    const branches = await prisma.studioBranch.findMany({
      where: { projectId: project.id },
    });
    expect(branches).toHaveLength(1);
    const cursor = await prisma.studioBranchCursor.findMany({
      where: { projectId: project.id },
    });
    expect(cursor).toEqual([
      expect.objectContaining({ userId: owner.id, branchId: branches[0].id }),
    ]);
    // The data blob keeps only the Studio meta, never the graph.
    expect(project.data.studio).toMatchObject({
      version: 2,
      initialPrompt: 'A 12 V buck',
    });
    expect(project.data.studio).not.toHaveProperty('nodes');

    const ws = await workspace(owner, project.id);
    expect(ws.branches).toHaveLength(1);
    expect(ws.activeBranchId).toBe(branches[0].id);
    expect(ws.stages.specs.status).toBe('empty');
  });

  it('creates, names, renames and checks out branches', async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    const main = await seedGraph(owner, project.id);

    const nodes = await prisma.studioNode.count({
      where: { projectId: project.id },
    });
    expect(nodes).toBe(2);

    // Fork after specs: the new branch has specs but no design yet.
    const alt = (
      await createBranch(owner, project.id, {
        name: 'Alt',
        fromNodeId: 'n_specs',
      }).expect(201)
    ).body as BranchView;
    expect(alt).toMatchObject({ name: 'Alt', headId: 'n_specs' });
    let ws = await workspace(owner, project.id);
    expect(ws.activeBranchId).toBe(alt.id);
    expect(ws.stages.specs.status).toBe('ready');
    expect(ws.stages.design.status).toBe('empty');

    // Same name again (any case) gets a number; renaming onto a taken name is 409.
    const second = (
      await createBranch(owner, project.id, { name: ' alt ' }).expect(201)
    ).body as BranchView;
    expect(second.name).toBe('alt 2');
    const taken = await request(http)
      .patch(`${PREFIX}/projects/${project.id}/branches/${second.id}`)
      .set(as(owner))
      .send({ name: 'ALT' })
      .expect(409);
    expect((taken.body as ErrorBody).code).toBe('BRANCH_NAME_TAKEN');
    await request(http)
      .patch(`${PREFIX}/projects/${project.id}/branches/${second.id}`)
      .set(as(owner))
      .send({ name: '   ' })
      .expect(400);
    const renamed = (
      await request(http)
        .patch(`${PREFIX}/projects/${project.id}/branches/${second.id}`)
        .set(as(owner))
        .send({ name: 'Second' })
        .expect(200)
    ).body as BranchView;
    expect(renamed.name).toBe('Second');

    // Fork just before design on main.
    const beforeDesign = (
      await createBranch(owner, project.id, {
        fromBranchId: main,
        forkBeforeStage: 'design',
      }).expect(201)
    ).body as BranchView;
    expect(beforeDesign.headId).toBe('n_specs');

    // Checkout picks the branch whose head is the result.
    const checkout = await request(http)
      .post(`${PREFIX}/projects/${project.id}/history/n_design/checkout`)
      .set(as(owner))
      .expect(200);
    expect(checkout.body).toEqual({ branchId: main, stage: 'design' });
    ws = await workspace(owner, project.id);
    expect(ws.activeBranchId).toBe(main);

    const history = (
      await request(http)
        .get(`${PREFIX}/projects/${project.id}/history`)
        .set(as(owner))
        .expect(200)
    ).body as { nodes: Array<{ id: string }>; heads: unknown[] };
    expect(history.nodes.map((n) => n.id)).toEqual(['n_specs', 'n_design']);
    expect(history.heads).toHaveLength(4);

    // Bad input.
    const missing = await createBranch(owner, project.id, {
      fromBranchId: 'br_missing',
    }).expect(404);
    expect((missing.body as ErrorBody).code).toBe('BRANCH_NOT_FOUND');
    const noNode = await createBranch(owner, project.id, {
      fromNodeId: 'n_missing',
    }).expect(404);
    expect((noNode.body as ErrorBody).code).toBe('NODE_NOT_FOUND');
    await request(http)
      .get(`${PREFIX}/projects/${project.id}/branches/bad id!/stages/specs`)
      .set(as(owner))
      .expect(400);
    await request(http)
      .get(`${PREFIX}/projects/${project.id}/branches/${main}/stages/nope`)
      .set(as(owner))
      .expect(400);
    const stage = await request(http)
      .get(`${PREFIX}/projects/${project.id}/branches/${main}/stages/design`)
      .set(as(owner))
      .expect(200);
    expect(stage.body).toMatchObject({ id: 'n_design', stage: 'design' });
  });

  it('shares branches with everyone; each person has their own current branch', async () => {
    const owner = await signUp();
    const editor = await signUp();
    const viewer = await signUp();
    const project = await createProject(owner);
    const main = await seedGraph(owner, project.id);
    for (const [who, role] of [
      [editor, 'EDITOR'],
      [viewer, 'VIEWER'],
    ] as const) {
      await request(http)
        .post(`${PREFIX}/projects/${project.id}/invitations`)
        .set(as(owner))
        .send({ emails: [who.email], role })
        .expect(201);
    }

    const alt = (
      await createBranch(editor, project.id, {
        name: 'Editor idea',
        fromNodeId: 'n_specs',
      }).expect(201)
    ).body as BranchView;

    // Everyone sees the editor's branch; only the editor moved onto it.
    for (const who of [owner, editor, viewer]) {
      const ws = await workspace(who, project.id);
      expect(ws.branches.map((b) => b.id)).toEqual([main, alt.id]);
    }
    expect((await workspace(owner, project.id)).activeBranchId).toBe(main);
    expect((await workspace(editor, project.id)).activeBranchId).toBe(alt.id);

    // Viewers can switch (their own cursor) but not change branches.
    const switched = (
      await request(http)
        .put(`${PREFIX}/projects/${project.id}/studio/active-branch`)
        .set(as(viewer))
        .send({ branchId: alt.id })
        .expect(200)
    ).body as Workspace;
    expect(switched).toMatchObject({ activeBranchId: alt.id, readOnly: true });
    expect((await workspace(owner, project.id)).activeBranchId).toBe(main);
    await createBranch(viewer, project.id, { name: 'x' }).expect(403);
    await request(http)
      .patch(`${PREFIX}/projects/${project.id}/branches/${alt.id}`)
      .set(as(viewer))
      .send({ name: 'mine' })
      .expect(403);
    await request(http)
      .delete(`${PREFIX}/projects/${project.id}/branches/${alt.id}`)
      .set(as(viewer))
      .expect(403);
    await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio/active-branch`)
      .set(as(viewer))
      .send({ branchId: 'br_missing' })
      .expect(404);

    // Strangers see nothing.
    const stranger = await signUp();
    await request(http)
      .get(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(stranger))
      .expect(404);
  });

  it('deletes a branch with only its own results; the last branch stays', async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    const main = await seedGraph(owner, project.id);
    const alt = (
      await createBranch(owner, project.id, {
        name: 'Alt',
        fromNodeId: 'n_specs',
      }).expect(201)
    ).body as BranchView;

    // A result only Alt has.
    const current = await detail(owner, project.id);
    expect(current.studio.activeBranchId).toBe(alt.id);
    const at = new Date().toISOString();
    await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(owner))
      .send({
        revision: current.revision,
        studio: {
          ...current.studio,
          nodes: {
            ...current.studio.nodes,
            n_alt: node('n_alt', 'design', 'n_specs', at),
          },
          branches: {
            ...current.studio.branches,
            [alt.id]: { ...current.studio.branches[alt.id], headId: 'n_alt' },
          },
        },
      })
      .expect(200);

    // A stale save is rejected instead of overwriting.
    const stale = await request(http)
      .put(`${PREFIX}/projects/${project.id}/studio`)
      .set(as(owner))
      .send({ revision: current.revision, studio: current.studio })
      .expect(409);
    expect((stale.body as ErrorBody).code).toBe('REVISION_CONFLICT');

    const deleted = await request(http)
      .delete(`${PREFIX}/projects/${project.id}/branches/${alt.id}`)
      .set(as(owner))
      .expect(200);
    expect(deleted.body).toEqual({ activeBranchId: main });
    const left = await prisma.studioNode.findMany({
      where: { projectId: project.id },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(left.map((n) => n.id)).toEqual(['n_design', 'n_specs']);

    const last = await request(http)
      .delete(`${PREFIX}/projects/${project.id}/branches/${main}`)
      .set(as(owner))
      .expect(409);
    expect((last.body as ErrorBody).code).toBe('LAST_BRANCH');
    await request(http)
      .delete(`${PREFIX}/projects/${project.id}/branches/${alt.id}`)
      .set(as(owner))
      .expect(404);
  });

  it('keeps names unique under concurrent creates', async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createBranch(owner, project.id, { name: 'Race' }),
      ),
    );
    for (const res of results) expect(res.status).toBe(201);
    const names = (await workspace(owner, project.id)).branches.map(
      (b) => b.name,
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(6);
  });

  it('moves an old project graph into tables on first open', async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    await prisma.studioBranch.deleteMany({ where: { projectId: project.id } });
    await prisma.studioNode.deleteMany({ where: { projectId: project.id } });
    const at = new Date().toISOString();
    const legacy = {
      version: 1,
      nodes: { n_old: node('n_old', 'specs', null, at) },
      branches: {
        br_a: {
          id: 'br_a',
          name: 'main',
          headId: 'n_old',
          forkedFromId: null,
          createdAt: at,
          colorIndex: 0,
        },
        br_b: {
          id: 'br_b',
          name: 'MAIN',
          headId: null,
          forkedFromId: null,
          createdAt: at,
          colorIndex: 1,
        },
      },
      branchOrder: ['br_a', 'br_b'],
      activeBranchId: 'br_b',
      focus: null,
      messages: [],
      createdAt: at,
    };
    await prisma.project.update({
      where: { id: project.id },
      data: { data: { studio: legacy } as unknown as Prisma.InputJsonObject },
    });

    const ws = await workspace(owner, project.id);
    // Old duplicate names are made unique; the stale cursor falls back.
    expect(ws.branches.map((b) => b.name)).toEqual(['main', 'MAIN 2']);
    expect(ws.stages.specs).toMatchObject({ status: 'ready', nodeId: 'n_old' });
    const stored = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    expect(
      (stored.data as { studio: { version: number } }).studio.version,
    ).toBe(2);
  });

  it('duplicates and restores versions with every branch', async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    await seedGraph(owner, project.id);
    const alt = (
      await createBranch(owner, project.id, {
        name: 'Alt',
        fromNodeId: 'n_specs',
      }).expect(201)
    ).body as BranchView;

    const copy = (
      await request(http)
        .post(`${PREFIX}/projects/${project.id}/duplicate`)
        .set(as(owner))
        .send({})
        .expect(201)
    ).body as ProjectDetail;
    const copied = await workspace(owner, copy.id);
    expect(copied.branches.map((b) => b.name)).toEqual(['main', 'Alt']);
    expect(
      await prisma.studioNode.count({ where: { projectId: copy.id } }),
    ).toBe(2);

    const version = (
      await request(http)
        .post(`${PREFIX}/projects/${project.id}/versions`)
        .set(as(owner))
        .send({ description: 'two branches' })
        .expect(201)
    ).body as { id: string };
    await request(http)
      .delete(`${PREFIX}/projects/${project.id}/branches/${alt.id}`)
      .set(as(owner))
      .expect(200);
    expect((await workspace(owner, project.id)).branches).toHaveLength(1);
    await request(http)
      .post(`${PREFIX}/projects/${project.id}/versions/${version.id}/restore`)
      .set(as(owner))
      .expect((res) => expect([200, 201]).toContain(res.status));
    const restored = await workspace(owner, project.id);
    expect(restored.branches.map((b) => b.name)).toEqual(['main', 'Alt']);
  });
});
