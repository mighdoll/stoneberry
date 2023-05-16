import { HasReactive, reactively } from "@reactively/decorate";
import {
  assignParams,
  createDebugBuffer,
  gpuTiming,
  reactiveTrackUse,
  trackContext,
} from "thimbleberry";
import { getApplyBlocksPipeline } from "./ApplyScanBlocksPipeline";
import { ScanTemplate, sumU32 } from "./ScanTemplate.js";
import { Cache, ComposableShader } from "./Scan.js";

export interface ApplyScanBlocksArgs {
  device: GPUDevice;
  partialScan: GPUBuffer;
  blockSums: GPUBuffer;
  workgroupLength?: number;
  label?: string;
  template?: ScanTemplate;
  exclusiveLarge?: boolean;
  pipelineCache?: <T extends object>() => Cache<T>;
}

const defaults: Partial<ApplyScanBlocksArgs> = {
  template: sumU32,
  label: "",
};

/** Shader stage used in a prefix scan, applies block summaries to block elements */
export class ApplyScanBlocks extends HasReactive implements ComposableShader {
  @reactively partialScan!: GPUBuffer;
  @reactively blockSums!: GPUBuffer;
  @reactively workgroupLength?: number;
  @reactively template!: ScanTemplate;
  @reactively label!: string;

  private device!: GPUDevice;
  private usageContext = trackContext();
  private pipelineCache?: <T extends object>() => Cache<T>;

  constructor(params: ApplyScanBlocksArgs) {
    super();
    assignParams<ApplyScanBlocks>(this, params, defaults);
  }

  commands(commandEncoder: GPUCommandEncoder): void {
    const timestampWrites = gpuTiming?.timestampWrites(this.label);
    const passEncoder = commandEncoder.beginComputePass({ timestampWrites });
    passEncoder.label = `apply scan blocks ${this.label}`;
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.dispatchWorkgroups(this.dispatchSize, 1, 1);
    passEncoder.end();
  }

  destroy(): void {
    this.usageContext.finish();
  }

  @reactively private get partialScanSize(): number {
    return this.partialScan.size;
  }

  @reactively private get dispatchSize(): number {
    const sourceElems = this.partialScanSize / Uint32Array.BYTES_PER_ELEMENT;
    const dispatchSize = Math.ceil(sourceElems / this.actualWorkgroupLength);
    return dispatchSize;
  }

  @reactively private get pipeline(): GPUComputePipeline {
    return getApplyBlocksPipeline(
      {
        device: this.device,
        workgroupLength: this.actualWorkgroupLength,
        template: this.template,
      },
      this.pipelineCache
    );
  }

  @reactively private get bindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      label: `apply scan blocks ${this.label}`,
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 2, resource: { buffer: this.partialScan } },
        { binding: 3, resource: { buffer: this.blockSums } },
        { binding: 4, resource: { buffer: this.result } },
        { binding: 11, resource: { buffer: this.debugBuffer } },
      ],
    });
  }

  @reactively get result(): GPUBuffer {
    const buffer = this.device.createBuffer({
      label: `apply scan blocks result ${this.label}`,
      size: this.partialScanSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    reactiveTrackUse(buffer, this.usageContext);
    return buffer;
  }

  @reactively private get actualWorkgroupLength(): number {
    const { device, workgroupLength: proposedLength } = this;
    const maxThreads = device.limits.maxComputeInvocationsPerWorkgroup;
    let length: number;
    if (!proposedLength || proposedLength > maxThreads) {
      length = maxThreads;
    } else {
      length = proposedLength;
    }
    return length;
  }

  @reactively get debugBuffer(): GPUBuffer {
    const buffer = createDebugBuffer(this.device, "ApplyScanBlocks debug");
    reactiveTrackUse(buffer, this.usageContext);
    return buffer;
  }
}
