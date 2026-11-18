#!/usr/bin/env node
// 测试用假 Agent 进程。
// 默认：打印两行后以 0 退出；--fail：打印错误并以 1 退出；--slow：每 100ms 输出一行，直到被杀掉；
// --echo-args：以 JSON 输出完整 argv，用于验证参数传递未被篡改。

const args = process.argv.slice(2)

if (args.includes('--echo-args')) {
  // JSON 编码保留 $&、引号、反引号等特殊字符，测试可以逐字节比较。
  console.log(JSON.stringify(args))
  process.exit(0)
}

if (args.includes('--fail')) {
  console.error('fake agent failed: --fail requested')
  process.exit(1)
}

if (args.includes('--slow')) {
  let index = 0
  // 上限只是防止测试异常时留下永久运行的进程，正常测试会提前 kill。
  const timer = setInterval(() => {
    index += 1
    console.log(`slow line ${index}`)
    if (index >= 600) {
      clearInterval(timer)
      process.exit(0)
    }
  }, 100)
} else {
  console.log('fake agent line 1')
  console.log('fake agent line 2')
}
