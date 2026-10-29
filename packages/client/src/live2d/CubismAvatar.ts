/**
 * CubismAvatar — a small, self-contained Cubism 5 model runner.
 *
 * The official SDK demo (LAppModel) is ~1100 lines of sample-app scaffolding
 * (scene manager, wav handler, hit-test bookkeeping). This is the subset the
 * Coexistir room needs: load a model3 bundle, run the idle motion loop, fire
 * a TapBody motion, apply an expression, and drive the LipSync parameter from
 * live audio. Theory of operation matches the SDK demo's update order
 * (EyeBlink 200 → Expression 300 → Breath 500 → Physics 600 → LipSync 700 →
 * Pose 800, then CubismModel.update()).
 *
 * Runtime licence: Live2D Cubism Web Framework (Live2D Open Software License),
 * Cubism Core (Live2D Proprietary Software License, redistributable as-is).
 * See ../live2d/framework/LICENSE.md, ../live2d/framework/NOTICE.md and
 * ../../public/live2d/core/LICENSE.md.
 */
import { CubismFramework, LogLevel, Option } from './framework/live2dcubismframework';
import { CubismModelSettingJson } from './framework/cubismmodelsettingjson';
import { CubismMoc } from './framework/model/cubismmoc';
import { CubismModel } from './framework/model/cubismmodel';
import { CubismRenderer_WebGL } from './framework/rendering/cubismrenderer_webgl';
import { CubismWebGLOffscreenManager } from './framework/rendering/cubismoffscreenmanager';
import { CubismMotion } from './framework/motion/cubismmotion';
import { CubismMotionManager } from './framework/motion/cubismmotionmanager';
import { CubismExpressionMotion } from './framework/motion/cubismexpressionmotion';
import { CubismExpressionMotionManager } from './framework/motion/cubismexpressionmotionmanager';
import { CubismPhysics } from './framework/physics/cubismphysics';
import { CubismPose } from './framework/effect/cubismpose';
import { CubismEyeBlink } from './framework/effect/cubismeyeblink';
import { BreathParameterData, CubismBreath } from './framework/effect/cubismbreath';
import { CubismModelMatrix } from './framework/math/cubismmodelmatrix';
import { CubismMatrix44 } from './framework/math/cubismmatrix44';
import { CubismIdHandle } from './framework/id/cubismid';
import { CubismLogError, CubismLogInfo, CubismLogWarning } from './framework/utils/cubismdebug';
import { ACubismMotion } from './framework/motion/acubismmotion';

const SHADER_PATH = 'live2d/shaders/';

/** Priority above idle, same value the SDK demo uses for "force". */
const PRIORITY_FORCE = 3;

/**
 * Upper-body framing, applied to the VIEW MATRIX (scale and translate in CLIP
 * space, where x/y run -1..1 and 2.0 is the full height). Never CSS
 * `transform: scale` — that resizes the drawing buffer and blurs the texture —
 * and never the model's own matrix, which also moves physics and hit areas.
 */
export interface AvatarFraming {
  /** Uniform zoom about the stage centre. 1 = the rig's own layout. */
  scale: number;
  /** Vertical shift in clip-space units: negative moves the model DOWN. */
  offsetY: number;
}

/**
 * Backing-store scale. devicePixelRatio is capped at 2 AND the total pixel
 * count is capped, because the renderer allocates mask targets and draws a 2048
 * texture atlas per pixel: a 1440p stage at dpr 2 would cost ~4x the fill of the
 * same stage at dpr 1 for a portrait nobody can tell apart at viewing distance.
 */
const MAX_BACKING_PIXELS = 2_400_000;

export function backingScale(cssWidth: number, cssHeight: number): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const byPixels = Math.sqrt(MAX_BACKING_PIXELS / Math.max(1, cssWidth * cssHeight));
  return Math.max(1, Math.min(dpr, 2, byPixels));
}

let frameworkReady = false;

/** One-time Cubism Core/framework start-up. Safe to call from every mount. */
export function ensureCubismFramework(): void {
  if (frameworkReady) return;
  if (typeof window === 'undefined') return;
  const core = (window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore;
  if (!core) {
    throw new Error('Live2D Cubism Core is not loaded (expected /live2d/core/live2dcubismcore.min.js)');
  }
  const option = new Option();
  option.loggingLevel = LogLevel.LogLevel_Warning;
  CubismFramework.startUp(option);
  CubismFramework.initialize();
  frameworkReady = true;
}

export interface CubismAvatarOptions {
  /** Absolute or root-relative URL of the model3.json, e.g. `/live2d/models/mao/Mao.model3.json`. */
  modelUrl: string;
  canvas: HTMLCanvasElement;
  /** Shown in debug logs; also useful when two models are on screen. */
  label?: string;
}

export interface AvatarMotionInfo {
  group: string;
  index: number;
}

function absUrl(modelUrl: string, file: string): string {
  const slash = modelUrl.lastIndexOf('/');
  const dir = slash >= 0 ? modelUrl.slice(0, slash + 1) : '';
  return dir + file;
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Live2D asset ${response.status}: ${url}`);
  return response.arrayBuffer();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Live2D texture failed: ${url}`));
    img.src = url;
  });
}

export class CubismAvatar {
  private readonly canvas: HTMLCanvasElement;
  private readonly modelUrl: string;
  private readonly gl: WebGLRenderingContext | WebGL2RenderingContext;
  private readonly setting: CubismModelSettingJson;
  private readonly moc: CubismMoc;
  private readonly model: CubismModel;
  private readonly renderer: CubismRenderer_WebGL;
  private readonly modelMatrix: CubismModelMatrix;

  private readonly motionManager = new CubismMotionManager();
  private readonly expressionManager = new CubismExpressionMotionManager();
  private motions = new Map<string, CubismMotion>();
  private expressions = new Map<string, ACubismMotion>();

  private physics: CubismPhysics | null = null;
  private pose: CubismPose | null = null;
  private eyeBlink: CubismEyeBlink | null = null;
  private breath: CubismBreath | null = null;

  private mouthId: CubismIdHandle | null = null;
  private readonly eyeBlinkIds: Array<CubismIdHandle> = [];
  private readonly lipSyncIds: Array<CubismIdHandle> = [];
  private mouthTarget = 0;
  private mouthValue = 0;

  private lastMotion: AvatarMotionInfo | null = null;
  private lastExpression: string | null = null;
  private framing: AvatarFraming = { scale: 1, offsetY: 0 };
  private disposed = false;
  private frame = 0;

  private constructor(
    canvas: HTMLCanvasElement,
    modelUrl: string,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    setting: CubismModelSettingJson,
    moc: CubismMoc,
    model: CubismModel,
  ) {
    this.canvas = canvas;
    this.modelUrl = modelUrl;
    this.gl = gl;
    this.setting = setting;
    this.moc = moc;
    this.model = model;
    this.renderer = new CubismRenderer_WebGL(canvas.width || 1, canvas.height || 1);
    this.modelMatrix = new CubismModelMatrix(model.getCanvasWidth(), model.getCanvasHeight());

    // Motions need these lists for automatic eye-blink / lip-sync suppression;
    // CubismMotion dereferences them unconditionally during updateParameters.
    for (let i = 0; i < setting.getEyeBlinkParameterCount(); i += 1) {
      this.eyeBlinkIds.push(setting.getEyeBlinkParameterId(i));
    }
    for (let i = 0; i < setting.getLipSyncParameterCount(); i += 1) {
      this.lipSyncIds.push(setting.getLipSyncParameterId(i));
    }
  }

  static async load(options: CubismAvatarOptions): Promise<CubismAvatar> {
    ensureCubismFramework();
    const { canvas, modelUrl } = options;

    const gl =
      (canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
      }) as WebGL2RenderingContext | null) ||
      (canvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
      }) as WebGLRenderingContext | null);

    if (!gl) throw new Error('WebGL is not available in this browser');

    // Size the drawing buffer before the renderer allocates mask render
    // targets: allocating them at the canvas' default 300x150 and then
    // resizing is what produces "Framebuffer status: Incomplete Attachment".
    const dpr = backingScale(canvas.clientWidth, canvas.clientHeight);
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));

    const settingBuffer = await fetchBuffer(modelUrl);
    const setting = new CubismModelSettingJson(settingBuffer, settingBuffer.byteLength);
    const mocBuffer = await fetchBuffer(absUrl(modelUrl, setting.getModelFileName()));
    const moc = CubismMoc.create(mocBuffer, true);
    if (!moc) throw new Error('Cubism Core rejected the .moc3');

    const model = moc.createModel();
    const avatar = new CubismAvatar(canvas, modelUrl, gl, setting, moc, model);

    avatar.renderer.initialize(model);
    avatar.renderer.startUp(gl);
    avatar.renderer.setIsPremultipliedAlpha(true);
    await avatar.loadTextures();
    avatar.setupLayout();
    await Promise.all([avatar.loadPhysics(), avatar.loadPose(), avatar.loadMotions(), avatar.loadExpressions()]);
    avatar.setupEffects();

    model.saveParameters();
    CubismLogInfo(`[live2d] ${options.label ?? 'avatar'} ready (${setting.getModelFileName()})`);
    return avatar;
  }

  // ---------------------------------------------------------------- loading

  private async loadTextures(): Promise<void> {
    const count = this.setting.getTextureCount();
    for (let i = 0; i < count; i += 1) {
      const file = this.setting.getTextureFileName(i);
      const img = await loadImage(absUrl(this.modelUrl, file));
      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.renderer.bindTexture(i, texture);
    }
  }

  private setupLayout(): void {
    const layout = new Map<string, number>();
    if (this.setting.getLayoutMap(layout)) {
      this.modelMatrix.setupFromLayout(layout);
    } else {
      this.modelMatrix.setHeight(2.0);
    }
  }

  private async loadPhysics(): Promise<void> {
    const file = this.setting.getPhysicsFileName();
    if (!file) return;
    const buffer = await fetchBuffer(absUrl(this.modelUrl, file));
    this.physics = CubismPhysics.create(buffer, buffer.byteLength);
  }

  private async loadPose(): Promise<void> {
    const file = this.setting.getPoseFileName();
    if (!file) return;
    const buffer = await fetchBuffer(absUrl(this.modelUrl, file));
    this.pose = CubismPose.create(buffer, buffer.byteLength);
  }

  private async loadMotions(): Promise<void> {
    const groups = this.setting.getMotionGroupCount();
    const jobs: Promise<void>[] = [];
    for (let g = 0; g < groups; g += 1) {
      const group = this.setting.getMotionGroupName(g);
      const count = this.setting.getMotionCount(group);
      for (let i = 0; i < count; i += 1) {
        const file = this.setting.getMotionFileName(group, i);
        jobs.push(
          fetchBuffer(absUrl(this.modelUrl, file)).then((buffer) => {
            const motion = CubismMotion.create(buffer, buffer.byteLength);
            if (motion) {
              motion.setEffectIds(this.eyeBlinkIds, this.lipSyncIds);
              this.motions.set(`${group}:${i}`, motion);
            }
          }),
        );
      }
    }
    await Promise.all(jobs);
  }

  private async loadExpressions(): Promise<void> {
    const count = this.setting.getExpressionCount();
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < count; i += 1) {
      const name = this.setting.getExpressionName(i);
      const file = this.setting.getExpressionFileName(i);
      jobs.push(
        fetchBuffer(absUrl(this.modelUrl, file)).then((buffer) => {
          const expression = CubismExpressionMotion.create(buffer, buffer.byteLength);
          if (expression) {
            this.expressions.set(name, expression);
          }
        }),
      );
    }
    await Promise.all(jobs);
  }

  private setupEffects(): void {
    if (this.setting.getEyeBlinkParameterCount() > 0) {
      this.eyeBlink = CubismEyeBlink.create(this.setting);
    }

    const id = (name: string) => CubismFramework.getIdManager().getId(name);
    this.breath = CubismBreath.create();
    this.breath.setParameters([
      new BreathParameterData(id('ParamAngleX'), 0.0, 15.0, 6.5345, 0.5),
      new BreathParameterData(id('ParamAngleY'), 0.0, 8.0, 3.5345, 0.5),
      new BreathParameterData(id('ParamAngleZ'), 0.0, 10.0, 5.5345, 0.5),
      new BreathParameterData(id('ParamBodyAngleX'), 0.0, 4.0, 15.5345, 0.5),
      new BreathParameterData(id('ParamBreath'), 0.5, 0.5, 3.2345, 1),
    ]);

    if (this.setting.getLipSyncParameterCount() > 0) {
      this.mouthId = this.setting.getLipSyncParameterId(0);
    } else {
      this.mouthId = id('ParamA');
    }
  }

  // ------------------------------------------------------------------ state

  get ready(): boolean {
    return !this.disposed;
  }

  get expressionNames(): string[] {
    return Array.from(this.expressions.keys());
  }

  get motionGroups(): string[] {
    const names = new Set<string>();
    this.motions.forEach((_motion, key) => names.add(key.split(':')[0]));
    return Array.from(names);
  }

  get currentExpression(): string | null {
    return this.lastExpression;
  }

  get currentMotion(): AvatarMotionInfo | null {
    return this.lastMotion;
  }

  /** Live LipSync parameter value (0..1) — exposed for verification. */
  get mouthOpen(): number {
    return this.mouthId ? this.model.getParameterValueById(this.mouthId) : 0;
  }

  setMouthOpen(value: number): void {
    this.mouthTarget = Math.min(1, Math.max(0, value));
  }

  /**
   * Shut the mouth NOW (barge-in). Setting the parameter as well as the target
   * means ParamA is 0 on the frame the cut lands, not 8 frames of easing later —
   * the visitor cut her off, so she must not finish the word she was on.
   */
  closeMouth(): void {
    this.mouthTarget = 0;
    this.mouthValue = 0;
    if (this.mouthId) this.model.setParameterValueById(this.mouthId, 0, 1.0);
  }

  /** Per-breakpoint upper-body framing (see AvatarFraming). */
  setFraming(framing: AvatarFraming | null): void {
    this.framing = framing ? { scale: framing.scale, offsetY: framing.offsetY } : { scale: 1, offsetY: 0 };
  }

  get currentFraming(): AvatarFraming {
    return this.framing;
  }

  // --------------------------------------------------------------- commands

  playMotion(group: string, index = 0): boolean {
    const key = `${group}:${index}`;
    const motion = this.motions.get(key);
    if (!motion) {
      CubismLogWarning(`[live2d] no motion ${key}`);
      return false;
    }
    this.motionManager.startMotionPriority(motion, false, PRIORITY_FORCE);
    this.lastMotion = { group, index };
    return true;
  }

  playRandomMotion(group: string): boolean {
    const indexes: number[] = [];
    this.motions.forEach((_motion, key) => {
      const [name, index] = key.split(':');
      if (name === group) indexes.push(Number(index));
    });
    if (indexes.length === 0) return false;
    return this.playMotion(group, indexes[Math.floor(Math.random() * indexes.length)]);
  }

  /**
   * Cut whatever is playing, now (barge-in).
   *
   * The motion queue is flushed rather than faded: the visitor spoke over her,
   * so the gesture she was mid-way through must not finish on its own. The Idle
   * loop restarts on the next update (`isFinished()` is true after a flush),
   * which is exactly the "she stops and listens" beat we want.
   */
  stopMotion(): void {
    this.motionManager.stopAllMotions();
    this.lastMotion = null;
  }

  setExpression(name: string): boolean {
    const expression = this.expressions.get(name);
    if (!expression) {
      CubismLogWarning(`[live2d] no expression ${name}`);
      return false;
    }
    this.expressionManager.startMotion(expression, false);
    this.lastExpression = name;
    return true;
  }

  // ------------------------------------------------------------------ frame

  resize(): boolean {
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    const dpr = backingScale(cssWidth, cssHeight);
    const width = Math.max(1, Math.floor(cssWidth * dpr));
    const height = Math.max(1, Math.floor(cssHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      return true;
    }
    return false;
  }

  update(deltaSeconds: number): void {
    if (this.disposed) return;
    const dt = Math.min(deltaSeconds, 1 / 15);
    const model = this.model;

    model.loadParameters();

    if (this.motionManager.isFinished()) {
      this.playRandomMotion('Idle');
    }
    this.motionManager.updateMotion(model, dt);
    model.saveParameters();

    this.eyeBlink?.updateParameters(model, dt);
    this.expressionManager.updateMotion(model, dt);
    this.breath?.updateParameters(model, dt);
    this.physics?.evaluate(model, dt);

    // Lipsync after physics, before pose: same slot as CubismUpdateOrder_LipSync.
    const smoothing = this.mouthTarget > this.mouthValue ? 0.55 : 0.18;
    this.mouthValue += (this.mouthTarget - this.mouthValue) * smoothing;
    if (this.mouthId) {
      model.setParameterValueById(this.mouthId, this.mouthValue, 1.0);
    }

    this.pose?.updateParameters(model, dt);
    model.update();
  }

  draw(): void {
    if (this.disposed) return;
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!this.ready) return;

    const projection = new CubismMatrix44();
    const canvasWidth = this.model.getCanvasWidth();
    if (canvasWidth > 1.0 && width < height) {
      this.modelMatrix.setWidth(2.0);
      projection.scale(1.0, width / height);
    } else {
      projection.scale(height / width, 1.0);
    }
    projection.multiplyByMatrix(this.modelMatrix);

    // Upper-body framing, LAST: scale about the stage centre, then shift, both
    // in clip space. Only the view matrix changes — the model's own matrix,
    // physics and hit areas are untouched, and nothing is CSS-scaled.
    if (this.framing.scale !== 1 || this.framing.offsetY !== 0) {
      const view = new CubismMatrix44();
      view.scale(this.framing.scale, this.framing.scale);
      view.translate(0, this.framing.offsetY);
      projection.multiplyByMatrix(view);
    }

    CubismWebGLOffscreenManager.getInstance().beginFrameProcess(gl);
    this.renderer.setMvpMatrix(projection);
    this.renderer.drawModel(SHADER_PATH);
    CubismWebGLOffscreenManager.getInstance().endFrameProcess(gl);
    CubismWebGLOffscreenManager.getInstance().releaseStaleRenderTextures(gl);
    this.frame += 1;
  }

  get renderedFrames(): number {
    return this.frame;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.expressionManager.release();
      this.motionManager.release();
      this.renderer.release();
      this.moc.deleteModel(this.model);
      CubismMoc.delete(this.moc);
    } catch (error) {
      CubismLogError(`[live2d] dispose: ${String(error)}`);
    }
  }
}
