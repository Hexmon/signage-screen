import { parseOperatorCommand, runOperatorCommand } from './cli'

async function main() {
  const command = parseOperatorCommand(process.argv)
  if (!command) {
    console.error('No operator command provided. Use one of: doctor, pair request, pair submit <PAIRING_CODE>, clear-cache, collect-logs')
    process.exitCode = 1
    return
  }

  const exitCode = await runOperatorCommand(command)
  process.exitCode = exitCode
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
