import { HasReactive, reactively } from "@reactively/decorate";
import {
  assignParams,
  limitWorkgroupLength,
  reactiveTrackUse,
  trackContext,
  trackUse,
  withBufferCopy,
} from "thimbleberry";
import { ApplyScanBlocks } from "./ApplyScanBlocks.js";
import { Cache, ComposableShader, ValueOrFn } from "./Scan.js";
import { ScanTemplate, sumU32 } from "./ScanTemplate.js";
import { WorkgroupScan } from "./WorkgroupScan.js";

export interface PrefixScanArgs {
  device: GPUDevice;
  src: ValueOrFn<GPUBuffer>;
  label?: string;
  template?: ValueOrFn<ScanTemplate>;
  workgroupLength?: ValueOrFn<number>;
  pipelineCache?: <T extends object>() => Cache<T>;
  exclusive?: boolean;
  initialValue?: number;
}

const defaults: Partial<PrefixScanArgs> = {
  workgroupLength: undefined,
  template: sumU32,
  pipelineCache: undefined,
  label: "",
  initialValue: undefined,
  exclusive: false,
};

/**
 * A cascade of shaders to do a prefix scan operation, based on a shader that
 * does a prefix scan of a workgroup sized chunk of data (e.g. perhaps 64 or 256 elements).
 *
 * The scan operation is parameterized by a template mechanism. The user can
 * instantiate a PrefixScan with sum to get prefix-sum, or use another template for
 * other parallel scan applications.
 *
 * For small data sets that fit in workgroup, only a single shader pass is needed.
 *
 * For larger data sets, a sequence of shaders is orchestrated as follows:
 * 1 one shader does a prefix scan on each workgroup sized chunk of data
 *   . it emits a partial prefix sum for each workgroup and single block level sum from each workgroup
 * 2 another instance of the same shader does a prefix scan on the block sums from the previous shader
 *   . the end result is a set of block level prefix sums
 * 3 a final shader sums the block prefix sums back with the partial prefix sums
 *
 * For for very large data sets, steps 2 and 3 repeat heirarchically.
 * Each level of summing reduces the data set by a factor of the workgroup size.
 * So three levels handles e.g. 16M elements (256 ** 3) if workgroup size is 256.
 * 
 * @typeParam T - Type of elements returned from the scan
 */
export class PrefixScan<T = number>
  extends HasReactive
  implements ComposableShader
{
  @reactively template!: ScanTemplate;
  @reactively src!: GPUBuffer;
  @reactively workgroupLength?: number;
  @reactively label?: string;
  @reactively initialValue?: number;
  @reactively exclusive!: boolean;

  private device!: GPUDevice;
  private usageContext = trackContext();
  private pipelineCache?: <C extends object>() => Cache<C>;

  constructor(args: PrefixScanArgs) {
    super();
    assignParams<PrefixScan<T>>(this, args, defaults);
  }

  commands(commandEncoder: GPUCommandEncoder): void {
    this.shaders.forEach(s => s.commands(commandEncoder));
  }

  destroy(): void {
    this.usageContext.finish();
  }

  /** Execute the prefix scan and copy the results back to the CPU */
  async scan(): Promise<number[]> {
    const commands = this.device.createCommandEncoder({
      label: `prefixScan ${this.label}`,
    });
    this.commands(commands);
    this.device.queue.submit([commands.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    const data = await withBufferCopy(this.device, this.result, "u32", d => d.slice()); // TODO support float and struct data types
    return [...data];
  }

  @reactively get result(): GPUBuffer {
    if (this.fitsInWorkGroup) {
      return this.sourceScan.prefixScan;
    } else {
      return this.applyScans.slice(-1)[0].result;
    }
  }

  @reactively private get shaders(): ComposableShader[] {
    return [this.sourceScan, ...this.blockScans, ...this.applyScans];
  }

  @reactively private get sourceScan(): WorkgroupScan {
    const exclusiveSmall = this.exclusive && this.fitsInWorkGroup;
    const shader = new WorkgroupScan({
      device: this.device,
      source: this.src,
      emitBlockSums: true,
      exclusiveSmall,
      initialValue: this.initialValue,
      template: this.template,
      workgroupLength: this.workgroupLength,
      label: `${this.label} sourceScan`,
      pipelineCache: this.pipelineCache,
    });
    reactiveTrackUse(shader, this.usageContext);
    return shader;
  }

  @reactively private get blockScans(): WorkgroupScan[] {
    const sourceElements = this.sourceSize / Uint32Array.BYTES_PER_ELEMENT;
    const wl = this.actualWorkgroupLength;
    const shaders: WorkgroupScan[] = [];

    // stitch a chain: blockSums as sources for scans
    let source = this.sourceScan.blockSums;
    let labelNum = 0;
    for (let elements = wl; elements < sourceElements; elements *= wl) {
      const last = elements * wl >= sourceElements;
      const blockScan = new WorkgroupScan({
        device: this.device,
        source,
        emitBlockSums: !last,
        template: this.template,
        workgroupLength: this.workgroupLength,
        label: `${this.label} blockToBlock ${labelNum++}`,
        pipelineCache: this.pipelineCache,
      });
      source = blockScan.blockSums;
      shaders.push(blockScan);
    }
    shaders.forEach(s => trackUse(s, this.usageContext));

    return shaders;
  }

  @reactively private get sourceSize(): number {
    return this.src.size;
  }

  @reactively private get fitsInWorkGroup(): boolean {
    const sourceElems = this.sourceSize / Uint32Array.BYTES_PER_ELEMENT;
    return sourceElems <= this.actualWorkgroupLength;
  }

  @reactively private get actualWorkgroupLength(): number {
    return limitWorkgroupLength(this.device, this.workgroupLength);
  }

  /** shader passes to apply block level sums to prefixes within the block */
  @reactively private get applyScans(): ApplyScanBlocks[] {
    if (this.fitsInWorkGroup) {
      return [];
    }
    const exclusiveLarge = this.exclusive; // if it was small, we'd have returned
    const blockShadersReverse = [...this.blockScans].reverse(); // block producing shaders in reverse order
    const blockPrefixesReverse = blockShadersReverse.map(s => s.prefixScan);

    // partial prefix scans (to which we'll sum with the block prefixes)
    const targetPrefixes = [...blockPrefixesReverse.slice(1), this.sourceScan.prefixScan];

    // stitch chain, with completed block prefixes as sources to the next applyBlock shader
    let blockSums = this.blockScans.slice(-1)[0].prefixScan;
    const allApplyBlocks = blockShadersReverse.map((s, i) => {
      const applyBlocks = new ApplyScanBlocks({
        device: this.device,
        partialScan: targetPrefixes[i],
        blockSums,
        template: this.template,
        exclusiveLarge, 
        initialValue: this.initialValue,
        workgroupLength: this.actualWorkgroupLength,
        label: `${this.label} applyBlock ${i}`,
        pipelineCache: this.pipelineCache,
      });
      blockSums = applyBlocks.result;
      return applyBlocks;
    });
    allApplyBlocks.forEach(s => trackUse(s, this.usageContext));
    return allApplyBlocks;
  }
}
