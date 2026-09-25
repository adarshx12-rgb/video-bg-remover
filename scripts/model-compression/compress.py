"""Weight-only compression of the withoutBG ONNX model.

fp16: every large float initializer is stored as float16 and Cast back to float32.
int8: weights of Gemm/Conv/FusedConv/ConvTranspose are stored as per-output-channel
      symmetric int8 + DequantizeLinear; other large initializers use the fp16 path.
Computation stays float32 in both, so only weight rounding changes the result.

Both variants also replace com.microsoft FusedMatMul (a CPU-only fusion baked into the
published file) with standard Transpose + MatMul + Mul. ONNX Runtime Web's WebGPU backend
has no FusedMatMul kernel, so those 12 attention matmuls otherwise run on the CPU with
large GPU<->CPU copies every frame.

Usage (Python 3.9+):
    python -m venv venv && venv/Scripts/pip install -r requirements.txt   # bin/ on macOS/Linux
    venv/Scripts/python compress.py withoutbg-open-weights.onnx withoutbg-open-weights-fp16w.onnx fp16
    venv/Scripts/python compress.py withoutbg-open-weights.onnx withoutbg-open-weights-int8w.onnx int8
Then update the SHA-256 values in WITHOUTBG_COMPRESSED (src/config.ts).
"""
import collections
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

MIN_ELEMS = 1024
# (op_type, input index) -> output-channel axis of that weight
WEIGHT_AXIS = {('Gemm', 1): None, ('Conv', 1): 0, ('FusedConv', 1): 0, ('ConvTranspose', 1): 1}


def gemm_axis(node):
    trans_b = next((helper.get_attribute_value(a) for a in node.attribute if a.name == 'transB'), 0)
    return 0 if trans_b else 1


def unfuse_matmul(graph):
    """FusedMatMul(A, B) = alpha * op(A) @ op(B) -> standard ops (4-D, transB only, as in this model)."""
    nodes, count = [], 0
    for node in graph.node:
        if node.op_type != 'FusedMatMul':
            nodes.append(node)
            continue
        attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
        if attrs.get('transA', 0) or attrs.get('transBatchA', 0) or attrs.get('transBatchB', 0):
            raise ValueError(f'Unsupported FusedMatMul attributes on {node.name}: {attrs}')
        a, b = node.input
        out = node.output[0]
        prefix = (node.name or out) + '_unfused'
        if attrs.get('transB', 0):
            nodes.append(helper.make_node('Transpose', [b], [prefix + '_bT'], perm=[0, 1, 3, 2], name=prefix + '_transpose'))
            b = prefix + '_bT'
        alpha = float(attrs.get('alpha', 1.0))
        if alpha == 1.0:
            nodes.append(helper.make_node('MatMul', [a, b], [out], name=prefix + '_matmul'))
        else:
            graph.initializer.append(numpy_helper.from_array(np.array(alpha, dtype=np.float32), prefix + '_alpha'))
            nodes.append(helper.make_node('MatMul', [a, b], [prefix + '_mm'], name=prefix + '_matmul'))
            nodes.append(helper.make_node('Mul', [prefix + '_mm', prefix + '_alpha'], [out], name=prefix + '_scale'))
        count += 1
    del graph.node[:]
    graph.node.extend(nodes)
    return count


def build(src, dst, mode):
    model = onnx.load(src)
    graph = model.graph
    consumers = collections.defaultdict(list)
    for node in graph.node:
        for i, name in enumerate(node.input):
            consumers[name].append((node, i))

    new_inits, new_nodes, stats = [], [], collections.Counter()
    for init in graph.initializer:
        w = numpy_helper.to_array(init)
        if init.data_type != TensorProto.FLOAT or w.size < MIN_ELEMS:
            new_inits.append(init)
            continue
        axes = set()
        for node, i in consumers[init.name]:
            key = (node.op_type, i)
            if key not in WEIGHT_AXIS:
                axes.add('other')
            else:
                axes.add(gemm_axis(node) if node.op_type == 'Gemm' else WEIGHT_AXIS[key])
        if mode == 'int8' and len(axes) == 1 and 'other' not in axes:
            axis = axes.pop()
            reduce_axes = tuple(a for a in range(w.ndim) if a != axis)
            scale = np.abs(w).max(axis=reduce_axes) / 127.0
            scale = np.where(scale == 0, 1.0, scale).astype(np.float32)
            shape = [1] * w.ndim
            shape[axis] = -1
            q = np.clip(np.round(w / scale.reshape(shape)), -127, 127).astype(np.int8)
            new_inits += [
                numpy_helper.from_array(q, init.name + '_q'),
                numpy_helper.from_array(scale, init.name + '_scale'),
                numpy_helper.from_array(np.zeros_like(scale, dtype=np.int8), init.name + '_zp'),
            ]
            new_nodes.append(helper.make_node('DequantizeLinear', [init.name + '_q', init.name + '_scale', init.name + '_zp'], [init.name], axis=axis))
            stats['int8'] += w.size
        else:
            if np.abs(w).max() > 65000:
                new_inits.append(init)  # would overflow float16
                stats['kept fp32'] += w.size
                continue
            new_inits.append(numpy_helper.from_array(w.astype(np.float16), init.name + '_fp16'))
            new_nodes.append(helper.make_node('Cast', [init.name + '_fp16'], [init.name], to=TensorProto.FLOAT))
            stats['fp16'] += w.size

    del graph.initializer[:]
    graph.initializer.extend(new_inits)
    nodes = new_nodes + list(graph.node)
    del graph.node[:]
    graph.node.extend(nodes)
    stats['FusedMatMul replaced'] = unfuse_matmul(graph)
    onnx.save(model, dst)
    print(dst, dict(stats))


if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2], sys.argv[3])
