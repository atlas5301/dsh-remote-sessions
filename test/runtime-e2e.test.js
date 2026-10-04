// Opt-in integration suite; never installs dependencies. Run with Node 22+:
// DSH_TEST_RUNTIME_ANCHOR=/absolute/installed/@deepseek-ai/dsh/package.json node --test test/runtime-e2e.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL } from '../lib/protocol.js';
import { forwardUpload } from '../lib/upload-relay.js';
import { startRuntime } from './runtime-harness.mjs';

function nativeWireAssertions() {
  // Test-only journal/stream oracle, not a UI implementation. Validate the actual
  // native wire frames without loading any rejected custom client or browser code.
  const text = blocks => (blocks ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
  const compact = blocks => (blocks ?? []).map(block => block.type === 'text-chunks' ? block.texts.join('') : block.type === 'text-delta' ? block.text : '').join('');
  return {
    MAX_EVENTS: Infinity,
    eventView(event) { return { role: event.type === 'user/message' ? 'You' : 'Assistant', text: text(event.data.content ?? event.data.message?.content) }; },
    snapshotState(frame) {
      assert.equal(frame.header.version, 4);
      const active = frame.assistantStream?.activeAttempt;
      return { header: frame.header, records: frame.records, cursor: frame.cursor, revision: frame.assistantStream?.revision,
        active: active ? { ...active, text: compact(active.stream) } : null };
    },
    acceptFrame(state, frame) {
      if (frame.type === 'event') {
        assert.equal(frame.event.seq, state.cursor + 1);
        return { ...state, records: [...state.records, frame], cursor: frame.event.seq,
          active: state.active && frame.event.type === 'assistant/message' ? { ...state.active, committed: true } : state.active };
      }
      assert.equal(frame.type, 'assistant-stream'); const value = frame.frame;
      if (value.type === 'start') return { ...state, revision: value.revision, active: { ...value.attempt, ...value, text: '', nextIndex: 0 } };
      if (value.type === 'chunk') {
        assert.ok(state.active); assert.equal(value.attemptId, state.active.attemptId);
        return { ...state, revision: value.revision, active: { ...state.active, text: state.active.text + compact([value.chunk]), nextIndex: value.index + 1 } };
      }
      assert.equal(value.type, 'end');
      return { ...state, revision: value.revision, active: null };
    },
  };
}

// A socket may deliver assistant/message and its later settlement in the same
// batch. Keep BOTH unread frames and reducer state across successive until()
// calls, and never share a cursor/revision across peers or follow streams.
const observations = new WeakMap();
function observation(peer, streamId) {
  const stream = observations.get(peer)?.get(streamId);
  assert.ok(stream, `Unknown observation: ${streamId}`);
  return stream;
}
function reduceFollow(stream, frame) {
  if (!stream.client) return;
  const before = stream.state;
  stream.state = frame.type === 'snapshot'
    ? stream.client.snapshotState(frame) : stream.client.acceptFrame(before, frame);
  stream.frames.push(frame);
  if (frame.type === 'assistant-stream' && frame.frame.type === 'end') {
    const outcome = frame.frame.outcome;
    assert.equal(stream.state.active, null, 'settled attempt must disappear from the live rendering');
    if (outcome.kind === 'committed') {
      const record = stream.state.records.find(record => record.event.seq === outcome.seq);
      assert.ok(record, 'stream settlement must name a rendered journal event');
      assert.equal(record.event.type, outcome.eventType);
      stream.settlements.push({ seq: outcome.seq, text: before.active.text });
    }
  }
}
function assertRenderedFollow(peer, streamId, prompts) {
  const stream = observation(peer, streamId), { client, state } = stream;
  const records = stream.frames.flatMap(frame => frame.type === 'snapshot' ? frame.records : frame.type === 'event' ? [frame] : []);
  // The fixture is smaller than the production bounded window. Every real
  // journal event must survive in the same order, without replay or omission.
  assert.ok(records.length < client.MAX_EVENTS);
  assert.deepEqual(Array.from(state.records), records);
  assert.equal(state.cursor, records.at(-1)?.event.seq ?? -1);
  const rendered = Array.from(state.records, record => ({ event: record.event, view: client.eventView(record.event) }));
  // Runtime-context injections are also user/message journal records. Preserve
  // them above, but distinguish actual user-origin prompts by their real source.
  const conversation = rendered.filter(({ event, view }) => (event.type === 'user/message' && event.data.source?.kind === 'user')
    || (event.type === 'assistant/message' && view.text.startsWith('runtime-e2e:')));
  assert.deepEqual(conversation.map(({ event, view }) => [event.type, view.role, view.text]),
    prompts.flatMap(({ text }) => [['user/message', 'You', text], ['assistant/message', 'Assistant', `runtime-e2e:${text}`]]));
  for (const { text, requestId } of prompts) {
    const user = rendered.find(({ event }) => event.type === 'user/message' && event.data.source?.rpcId === requestId);
    assert.ok(user, `real user event must retain source.rpcId ${requestId}`);
    assert.equal(user.event.data.source.kind, 'user');
    assert.equal(user.view.text, text);
  }
  for (const settlement of stream.settlements) {
    const committed = rendered.find(({ event }) => event.seq === settlement.seq);
    if (committed.event.type === 'assistant/message' && committed.view.text.startsWith('runtime-e2e:')) {
      assert.equal(settlement.text, committed.view.text, 'live assistant text must exactly equal the durable rendered answer');
    }
  }
  return stream;
}

const anchor = process.env.DSH_TEST_RUNTIME_ANCHOR;
const skip = !anchor && 'Set DSH_TEST_RUNTIME_ANCHOR to an existing installed @deepseek-ai/dsh/package.json (Node 22+)';


async function call(peer, endpoint, request) {
  const result = await peer.request('call', { endpoint, values: request === undefined ? [] : [request] });
  assert.equal(result.ok, true, `${endpoint}: ${JSON.stringify(result)}`);
  return result.value;
}
async function open(peer, endpoint, request, client) {
  const { streamId } = await peer.request('open', { endpoint, values: request === undefined ? [] : [request] });
  if (client) {
    assert.equal(endpoint, 'session/follow');
    assert.equal(request.assistantStream, true, 'client reducer requires the real assistant stream baseline');
  }
  if (!observations.has(peer)) observations.set(peer, new Map());
  observations.get(peer).set(streamId, { pending: [], frames: [], settlements: [], state: null, client });
  return streamId;
}
async function next(peer, streamId) {
  const result = await peer.request('next', { streamId, waitMs: 1000 });
  assert.equal(result.done, false, 'live DSH observer unexpectedly closed');
  return result.items;
}
async function until(peer, streamId, predicate, timeout = 15000) {
  const frames = [], stream = observation(peer, streamId);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!stream.pending.length) stream.pending.push(...await next(peer, streamId));
    while (stream.pending.length) {
      const frame = stream.pending.shift();
      reduceFollow(stream, frame);
      frames.push(frame);
      if (predicate(frame)) return { frame, frames, state: stream.state };
    }
  }
  assert.fail(`Expected DSH frame did not arrive: ${JSON.stringify(frames)}`);
}
async function settleAnswer(peer, streamId, answer) {
  const stream = observation(peer, streamId);
  assert.equal(stream.state.active?.committed, true, 'durable message hides the live preview before stream end');
  assert.equal(stream.state.active.text, stream.client.eventView(answer.frame.event).text);
  const settled = await until(peer, streamId, frame => frame.type === 'assistant-stream'
    && frame.frame.type === 'end' && frame.frame.outcome?.seq === answer.frame.event.seq);
  assert.equal(settled.state.active, null);
  await until(peer, streamId, frame => frame.event?.type === 'turn/end');
  assert.equal(stream.state.active, null);
}
function hasAnswer(frame, text) {
  const records = frame.type === 'snapshot' ? frame.records : [frame];
  return records.some(record => record.event?.type === 'assistant/message'
    && record.event.data.message?.content.some(part => part.type === 'text' && part.text === text));
}
async function prompt(peer, sessionId, text, requestId = randomUUID()) {
  return call(peer, 'session/prompt', { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] });
}

test('native backend proxy: standalone plugin drives remote Agent without dsh-remote', { skip, timeout: 30000 }, async t => {
  const remote = await startRuntime(t), host = await startRuntime(t, { proxyRuntime: remote });
  const native = await host.connect(), direct = await remote.connect();
  const { workspace } = await call(native, 'workspace/create', { path: join(host.root, 'remote-workspace') });
  const { sessionId } = await call(native, 'session/create', { workspaceId: workspace.workspaceId });
  const workspaceFollow = await open(native, 'workspace/follow');
  const workspaceSnapshot = await until(native, workspaceFollow, frame => JSON.stringify(frame).includes(sessionId));
  assert.ok(JSON.stringify(workspaceSnapshot.frame).includes(workspace.workspaceId), 'native workspace accounts the proxy session');
  const localRows = (await call(native, 'session/list', {})).items;
  const remoteRows = (await call(direct, 'session/list', {})).items;
  assert.equal(localRows.length, 1); assert.equal(localRows[0].cwd, join(host.root, 'remote-workspace'));
  assert.equal(remoteRows[0].sessionId, sessionId); assert.equal(remoteRows[0].cwd, join(remote.root, 'workspace'));
  let follow = await open(native, 'session/follow', { address: { kind: 'session', sessionId }, assistantStream: true });
  const baseline = await until(native, follow, frame => frame.type === 'snapshot');
  assert.equal(baseline.frame.header.id, sessionId); assert.equal(baseline.frame.header.cwd, join(host.root, 'remote-workspace'));
  const renamed = await call(native, 'session/rename', { sessionId, title: 'Remote through native UI' });
  assert.equal(renamed.title, 'Remote through native UI');
  const selectedModel = await native.request('call', { endpoint: 'session/selectModel', confirmDefaultChange: true, values: [{ sessionId, provider: 'runtime-e2e', model: 'deterministic' }] });
  assert.equal(selectedModel.ok, true, JSON.stringify(selectedModel));
  assert.equal((await call(native, 'session/projections', { sessionId })).values.modelSelection.next.model, 'deterministic');
  const catalog = await call(native, 'session/modelCatalog');
  assert.ok(catalog.groups.some(group => group.id === 'runtime-e2e'));
  const commands = await native.request('call', { endpoint: 'commands/list', values: [sessionId] });
  assert.equal(commands.ok, true, JSON.stringify(commands));
  const refs = await native.request('call', { endpoint: 'fileReferences/list', values: [sessionId, ''] });
  assert.equal(refs.ok, true, JSON.stringify(refs));
  const nativeEvents = await open(native, '$events');
  const nativeReady = await until(native, nativeEvents, frame => frame.type === 'ready');
  const nativeControl = await open(native, 'session/control');
  await until(native, nativeControl, frame => frame.type === 'baseline');
  await prompt(native, sessionId, 'approval-roundtrip');
  const approval = await until(native, nativeEvents, frame => frame.type === 'waterfall' && frame.event === 'approval/request');
  assert.equal(approval.frame.agentId, sessionId);
  assert.equal(remote.messages.some(message => message.type === 'tool-executed'), false);
  await native.request('close', { streamId: nativeEvents });
  const recoveredEvents = await open(native, '$events');
  const recoveredReady = await until(native, recoveredEvents, frame => frame.type === 'ready');
  assert.notEqual(recoveredReady.frame.clientId, nativeReady.frame.clientId);
  const replayedApproval = await until(native, recoveredEvents, frame => frame.type === 'waterfall' && frame.event === 'approval/request');
  assert.equal(replayedApproval.frame.eventId, approval.frame.eventId);
  assert.equal(remote.messages.some(message => message.type === 'tool-executed'), false);
  host.child.send({ type: 'drop-native-relay' }); await host.message('native-relay-dropped');
  await call(native, 'session/list', {}); // native refresh reconnects backend observation
  const rebridgedApproval = await until(native, recoveredEvents, frame => frame.type === 'waterfall' && frame.event === 'approval/request' && frame.eventId !== replayedApproval.frame.eventId);
  assert.equal(rebridgedApproval.frame.agentId, sessionId);
  follow = await open(native, 'session/follow', { address: { kind: 'session', sessionId }, assistantStream: true });
  const receipt = await native.request('event-result', { clientId: recoveredReady.frame.clientId, eventId: rebridgedApproval.frame.eventId, outcome: { kind: 'result', value: 'allowed-once' } });
  assert.equal(receipt.ok, true); await remote.message('tool-executed');
  await until(native, follow, frame => hasAnswer(frame, 'runtime-e2e:approval-roundtrip'));
  const firstTurn = await until(native, follow, frame => frame.event?.type === 'turn/end');
  const history = await call(native, 'session/page', { address: { kind: 'session', sessionId }, throughSeq: firstTurn.frame.event.seq, maxMessages: 20 });
  assert.ok(history.records.some(record => record.event.type === 'assistant/message'));
  const search = await call(native, 'session/search', { query: 'approval-roundtrip' });
  assert.ok(search.items.some(item => item.sessionId === sessionId));
  await until(native, nativeControl, frame => frame.type === 'projection' && frame.sessionId === sessionId);
  remote.child.send({ type: 'native-question', sessionId });
  const question = await until(native, recoveredEvents, frame => frame.type === 'waterfall' && frame.event === 'user-questions/request');
  const answer = { answers: [{ id: 'choice', selected: ['Yes'] }] };
  await native.request('event-result', { clientId: recoveredReady.frame.clientId, eventId: question.frame.eventId, outcome: { kind: 'result', value: answer } });
  assert.deepEqual((await remote.message('native-question-answered')).answer, answer);
  remote.child.send({ type: 'native-timed-question', sessionId });
  const timed = await until(native, recoveredEvents, frame => frame.type === 'waterfall' && frame.request?.wait?.timed);
  const wait = await native.request('open', { endpoint: 'userQuestions/attachWait', values: [sessionId, timed.frame.request.wait.callId] });
  const waitFrame = await native.request('next', { streamId: wait.streamId, waitMs: 1000 });
  assert.ok(waitFrame.items.length > 0, 'native timed UI claims the REMOTE wait');
  const timedAnswer = { answers: [{ id: 'timed', selected: ['Yes'] }] };
  await native.request('event-result', { clientId: recoveredReady.frame.clientId, eventId: timed.frame.eventId, outcome: { kind: 'result', value: timedAnswer } });
  assert.deepEqual((await remote.message('native-timed-answered')).answer, timedAnswer);
  await native.request('close', { streamId: wait.streamId });
  await prompt(native, sessionId, 'hold-model-native-cancel'); await remote.message('model-waiting');
  await call(native, 'session/cancel', { sessionId }); await remote.message('model-aborted');
  await until(native, follow, frame => frame.event?.type === 'turn/end');
  const upload = await forwardUpload((method, params, signal) => native.request(method, params, { signal }), { sessionId, name: 'fixture.txt', data: (async function* () { yield Buffer.from('remote-upload-'); yield Buffer.from('bytes'); })() });
  assert.equal(upload.file.name, 'fixture.txt');
  const encoded = await native.request('call', { endpoint: 'fileUploads/upload', values: [sessionId, { name: 'native-encoded.txt', data: Buffer.from('native encoded bytes').toString('base64') }] });
  assert.equal(encoded.ok, true, JSON.stringify(encoded));
  assert.equal(encoded.value.file.name, 'native-encoded.txt');
  host.child.send({ type: 'native-binary-upload', sessionId });
  const binary = (await host.message('native-binary-uploaded')).result;
  assert.equal(binary.ok, true, JSON.stringify(binary)); assert.equal(binary.value.file.bytes, 500003);
  remote.child.send({ type: 'assert-upload-bytes', file: binary.value.file }); await remote.message('upload-bytes-verified');
  await call(native, 'session/prompt', { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'hold-model-native-proxy' }, { type: 'image', mediaType: 'image/png', name: 'native-test.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4DwYMEAoAU7oL9W/sIDEAAAAASUVORK5CYII=' }, { type: 'file', receiptId: upload.receiptId }, { type: 'file', receiptId: encoded.value.receiptId }, { type: 'file', receiptId: binary.value.receiptId }] });
  await remote.message('model-waiting');
  host.child.send({ type: 'assert-no-local-agent' }); await host.message('no-local-agent');
  host.child.send({ type: 'reload-native-proxy' }); assert.equal((await host.message('native-proxy-reloaded')).count, 1);
  assert.equal((await call(native, 'session/list', {})).items[0].sessionId, sessionId);
  const reattached = await open(native, 'session/follow', { address: { kind: 'session', sessionId }, assistantStream: true });
  const active = await until(native, reattached, frame => frame.type === 'snapshot');
  assert.ok(active.frame.assistantStream.activeAttempt, 'reloaded backend observes the existing running attempt');
  const image = active.frame.records.flatMap(record => record.event?.type === 'user/message' ? record.event.data.content : []).find(part => part.type === 'image');
  assert.ok(image?.attachment?.attachmentId, 'remote image admission publishes native durable reference');
  const imageRead = await call(native, 'session/attachment', { sessionId, attachmentId: image.attachment.attachmentId });
  assert.ok(imageRead.data.length > 0); assert.equal(imageRead.attachment.attachmentId, image.attachment.attachmentId);
  host.child.send({ type: 'drop-native-relay' }); await host.message('native-relay-dropped');
  const afterDrop = await open(native, 'session/follow', { address: { kind: 'session', sessionId }, assistantStream: true });
  const sameRun = await until(native, afterDrop, frame => frame.type === 'snapshot');
  assert.equal(sameRun.frame.assistantStream.activeAttempt.attemptId, active.frame.assistantStream.activeAttempt.attemptId);
  assert.equal(remote.messages.some(message => message.type === 'model-aborted'), false);
  native.close(); await host.stop(); // kill the entire local DSH process, not merely its UI observer
  assert.equal(remote.messages.some(message => message.type === 'model-aborted'), false);
  await host.restart();
  const reopened = await host.connect();
  assert.equal((await call(reopened, 'session/list', {})).items[0].sessionId, sessionId);
  const afterRestart = await open(reopened, 'session/follow', { address: { kind: 'session', sessionId }, assistantStream: true });
  const running = await until(reopened, afterRestart, frame => frame.type === 'snapshot');
  assert.equal(running.frame.assistantStream.activeAttempt.attemptId, active.frame.assistantStream.activeAttempt.attemptId);
  host.child.send({ type: 'assert-no-local-agent' }); await host.message('no-local-agent');
  remote.child.send({ type: 'release-model' }); await remote.message('model-completed');
  const recovered = await open(direct, 'session/follow', { address: { kind: 'session', sessionId }, assistantStream: true });
  await until(direct, recovered, frame => hasAnswer(frame, 'runtime-e2e:hold-model-native-proxy'));
  assert.equal(remote.messages.some(message => message.type === 'model-aborted'), false);
  await until(reopened, afterRestart, frame => hasAnswer(frame, 'runtime-e2e:hold-model-native-proxy'));
  await until(reopened, afterRestart, frame => frame.event?.type === 'turn/end');
  await remote.stop();
  const offline = (await call(reopened, 'session/list', {})).items.find(item => item.sessionId === sessionId);
  assert.equal(offline.agentAvailable, false);
  const refused = await reopened.request('call', { endpoint: 'session/prompt', values: [{ sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'never fall back' }] }] });
  assert.equal(refused.ok, false);
  host.child.send({ type: 'assert-no-local-agent' }); await host.message('no-local-agent');
  const local = await call(reopened, 'session/create', { cwd: join(host.root, 'workspace') });
  const localFollow = await open(reopened, 'session/follow', { address: { kind: 'session', sessionId: local.sessionId }, assistantStream: true });
  await prompt(reopened, local.sessionId, 'ordinary-local-still-works');
  await until(reopened, localFollow, frame => hasAnswer(frame, 'runtime-e2e:ordinary-local-still-works'));
});

test('installed DSH: companion waits for asynchronously registered public descriptors', { skip, timeout: 20000 }, async t => {
  const runtime = await startRuntime(t, { delayDescriptors: true });
  await runtime.message('descriptors-released');
  const peer = await runtime.connect();
  const hello = await peer.request('hello', { protocol: PROTOCOL });
  assert.ok(hello.capabilities.some(capability => capability.endpoint === 'session/create'));
  assert.deepEqual((await call(peer, 'session/list', {})).items, []);
});

test('installed DSH: resident create/list/follow, real prompt, reconnect and approval replay', { skip, timeout: 60000 }, async t => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'run with Node 22+');
  const client = nativeWireAssertions();
  const runtime = await startRuntime(t);
  const prompts = ['basic-real-loop', 'hold-model-across-disconnect', 'approval-roundtrip'].map(text => ({ text, requestId: randomUUID() }));
  const first = await runtime.connect();
  const hello = await first.request('hello', { protocol: PROTOCOL });
  assert.equal(hello.protocol, PROTOCOL);
  for (const endpoint of ['session/create', 'session/list', 'session/prompt', 'session/follow', 'session/page', 'session/control']) {
    assert.ok(hello.capabilities.some(capability => capability.endpoint === endpoint), `readiness missed ${endpoint}`);
  }
  assert.deepEqual((await call(first, 'session/list', {})).items, []);
  const { sessionId } = await call(first, 'session/create', { cwd: join(runtime.root, 'workspace') });
  assert.equal(typeof sessionId, 'string');
  const list = await call(first, 'session/list', {});
  assert.ok(list.items.some(item => item.sessionId === sessionId && item.agentAvailable), JSON.stringify(list));
  const address = { kind: 'session', sessionId };
  const follow = await open(first, 'session/follow', { address, assistantStream: true }, client);
  const opening = await until(first, follow, frame => frame.type === 'snapshot');
  assert.equal(opening.state.header.version, 4);
  assert.equal(opening.state.header.id, sessionId);
  assert.equal(opening.state.header.cwd, join(runtime.root, 'workspace'));
  assert.equal(opening.state.active, null);
  assert.deepEqual(await prompt(first, sessionId, prompts[0].text, prompts[0].requestId), { accepted: true });
  const basic = await until(first, follow, frame => hasAnswer(frame, 'runtime-e2e:basic-real-loop'));
  await runtime.message('model-completed');
  await settleAnswer(first, follow, basic);
  const firstStream = assertRenderedFollow(first, follow, prompts.slice(0, 1));
  assert.ok(firstStream.frames.some(frame => frame.type === 'assistant-stream' && frame.frame.type === 'start'));
  assert.ok(firstStream.frames.some(frame => frame.type === 'assistant-stream' && frame.frame.chunk?.type === 'text-delta'));
  assert.ok(firstStream.settlements.some(settlement => settlement.seq === basic.frame.event.seq));

  assert.deepEqual(await prompt(first, sessionId, prompts[1].text, prompts[1].requestId), { accepted: true });
  await runtime.message('model-waiting');
  const inFlight = await until(first, follow, () => observation(first, follow).state.active?.text === 'runtime-e2e:');
  assert.equal(inFlight.state.active.committed, undefined);
  first.close();
  await first.done;
  const second = await runtime.connect();
  const helloAgain = await second.request('hello', { protocol: PROTOCOL });
  assert.equal(helloAgain.runtimeId, hello.runtimeId);
  assert.equal(helloAgain.instanceId, hello.instanceId, 'must reconnect to same resident runtime');
  const rejoined = await open(second, 'session/follow', { address, assistantStream: true }, client);
  const baseline = await until(second, rejoined, frame => frame.type === 'snapshot');
  assert.equal(baseline.state.header.version, 4);
  assert.equal(baseline.state.header.id, sessionId);
  assert.ok(baseline.frame.assistantStream?.activeAttempt, 'real in-flight model survives detach');
  assert.equal(baseline.state.active.text, 'runtime-e2e:', 'compact reconnect baseline renders the already-streamed prefix');
  assert.equal(baseline.state.active.attemptId, inFlight.state.active.attemptId);
  assert.equal(baseline.state.active.nextIndex, inFlight.state.active.nextIndex);
  assert.equal(baseline.state.revision, inFlight.state.revision);
  assert.equal(runtime.messages.some(message => message.type === 'model-aborted'), false);
  runtime.child.send({ type: 'release-model' });
  const finished = await until(second, rejoined, frame => hasAnswer(frame, 'runtime-e2e:hold-model-across-disconnect'));
  await runtime.message('model-completed');
  await settleAnswer(second, rejoined, finished);
  const secondStream = assertRenderedFollow(second, rejoined, prompts.slice(0, 2));
  assert.ok(secondStream.settlements.some(settlement => settlement.seq === finished.frame.event.seq));
  assert.equal(runtime.messages.some(message => message.type === 'model-aborted'), false);
  const last = finished.frame.event.seq;
  const page = await call(second, 'session/page', { address, throughSeq: last, maxMessages: 100 });
  assert.ok(hasAnswer({ type: 'snapshot', records: page.records }, 'runtime-e2e:basic-real-loop'));
  assert.ok(hasAnswer({ type: 'snapshot', records: page.records }, 'runtime-e2e:hold-model-across-disconnect'));
  assert.deepEqual(Array.from(secondStream.state.records).filter(record => record.event.seq <= last), page.records,
    'client event order must match the independently paged real journal');
  // Exercise the installed approval waterfall, Gateway pending-event replay,
  // and actual tool dispatch. The tool has no filesystem/process side effects.
  const events = await open(second, '$events');
  const ready = (await until(second, events, frame => frame.type === 'ready')).frame;
  assert.equal(typeof ready.clientId, 'string');
  await prompt(second, sessionId, prompts[2].text, prompts[2].requestId);
  const question = (await until(second, events, frame => frame.type === 'waterfall' && frame.event === 'approval/request')).frame;
  assert.equal(question.agentId, sessionId);
  assert.equal(runtime.messages.some(message => message.type === 'tool-executed'), false);
  second.close();
  await second.done;
  const third = await runtime.connect();
  assert.equal((await third.request('hello', { protocol: PROTOCOL })).instanceId, hello.instanceId);
  const replayEvents = await open(third, '$events');
  const replayReady = (await until(third, replayEvents, frame => frame.type === 'ready')).frame;
  const replayQuestion = (await until(third, replayEvents, frame => frame.type === 'waterfall' && frame.event === 'approval/request')).frame;
  assert.equal(replayQuestion.eventId, question.eventId, 'pending approval retains its identity across transports');
  const replayFollow = await open(third, 'session/follow', { address, assistantStream: true }, client);
  await until(third, replayFollow, frame => frame.type === 'snapshot');
  const answer = await third.request('event-result', {
    clientId: replayReady.clientId, eventId: replayQuestion.eventId,
    outcome: { kind: 'result', value: 'allowed-once' },
  });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  await runtime.message('tool-executed');
  const approvalFinished = await until(third, replayFollow, frame => hasAnswer(frame, 'runtime-e2e:approval-roundtrip'));
  await runtime.message('model-completed');
  const audit = await call(third, 'session/page', { address, throughSeq: approvalFinished.frame.event.seq, maxMessages: 100 });
  assert.ok(audit.records.some(record => record.event.type === 'tool/result' && JSON.stringify(record.event.data).includes('real-tool-result')));
  assert.ok(audit.records.some(record => record.event.type.startsWith('approval/') && JSON.stringify(record.event.data).includes('allowed-once')));
  await settleAnswer(third, replayFollow, approvalFinished);
  const thirdStream = assertRenderedFollow(third, replayFollow, prompts);
  assert.ok(thirdStream.settlements.some(settlement => settlement.seq === approvalFinished.frame.event.seq));
  assert.deepEqual(Array.from(thirdStream.state.records).filter(record => record.event.seq <= approvalFinished.frame.event.seq), audit.records,
    'replayed approval and tool events must render in real journal order');
  const toolResult = thirdStream.state.records.find(record => record.event.type === 'tool/result');
  assert.equal(client.eventView(toolResult.event).text, 'real-tool-result');
  assert.ok(toolResult.event.seq < approvalFinished.frame.event.seq, 'tool result renders before the final answer');
  const live = (await call(third, 'session/list', {})).items.find(item => item.sessionId === sessionId);
  assert.equal(live.agentAvailable, true);
  assert.equal(live.running, false);
  await third.request('close', { streamId: replayEvents });
  await third.request('close', { streamId: replayFollow });
  const socket = await fs.stat(join(runtime.root, 'run', 'agent.sock'));
  assert.equal(socket.mode & 0o777, 0o600);
  assert.equal((await fs.stat(join(runtime.root, 'run', 'runtime-id'))).mode & 0o777, 0o600);
  assert.deepEqual(await runtime.stop(), { code: 0, signal: null }, 'owned runtime must dispose cleanly');
  // A public page may read an attached session. Check physical journal bytes
  // after orderly shutdown as well, proving the real JSONL backend flushed.
  const sessionsRoot = join(runtime.root, 'home', 'sessions');
  const artifacts = (await fs.readdir(sessionsRoot, { recursive: true })).filter(name => name.endsWith('.jsonl'));
  assert.ok(artifacts.length > 0, 'installed session persistence must create actual artifacts');
  const journal = (await Promise.all(artifacts.map(name => fs.readFile(join(sessionsRoot, name), 'utf8')))).join('\n');
  for (const answer of ['runtime-e2e:basic-real-loop', 'runtime-e2e:hold-model-across-disconnect', 'runtime-e2e:approval-roundtrip', 'real-tool-result', 'allowed-once']) {
    assert.ok(journal.includes(answer), `durable journal missing ${answer}`);
  }
});
