import json
import os
import tempfile

from openhands.core.logger import openhands_logger as logger
from openhands.linter.linter import BaseLinter, LintResult
from openhands.linter.utils import check_tool_installed, run_cmd

# TODO: maybe we should add it as a dependency of OpenHands?
TS_INSTALLED = check_tool_installed('tsc')
if not TS_INSTALLED:
    logger.warning(
        'TypeScript is not installed. Please install it to use the TypeScript linter.'
    )
ESLINT_INSTALLED = check_tool_installed('eslint')
if not ESLINT_INSTALLED:
    logger.warning(
        'ESLint is not installed. Please install it to use the TypeScript linter.'
    )

LINTER_INSTALLED = TS_INSTALLED or ESLINT_INSTALLED


def ts_eslint(
    filepath: str,
    plugin_dir: str | None = None,
) -> list[LintResult]:
    """Use ESLint to check for errors. If ESLint is not installed return an empty list."""
    if not ESLINT_INSTALLED:
        return []

    # Enhanced ESLint configuration with React support
    eslint_config = {
        'env': {'es6': True, 'browser': True, 'node': True},
        'extends': ['eslint:recommended', 'plugin:react/recommended'],
        'parserOptions': {
            'ecmaVersion': 2021,
            'sourceType': 'module',
            'ecmaFeatures': {'jsx': True},
        },
        'plugins': ['react'],
        'rules': {
            'no-unused-vars': 'warn',
            'no-console': 'off',
            'react/prop-types': 'warn',
            'semi': ['error', 'always'],
        },
        'settings': {'react': {'version': 'detect'}},
    }

    # Write config to a temporary file
    with tempfile.NamedTemporaryFile(
        mode='w', suffix='.json', delete=False
    ) as temp_config:
        json.dump(eslint_config, temp_config)
        temp_config_path = temp_config.name

    try:
        eslint_cmd = (
            f'eslint --no-eslintrc --config {temp_config_path} --format json {filepath}'
        )
        if plugin_dir:
            # e.g., <project_root>/frontend/node_modules/
            eslint_cmd += f' --resolve-plugins-relative-to {plugin_dir}'
        print(eslint_cmd)
        eslint_res: str | None = None
        try:
            eslint_res = run_cmd(eslint_cmd)
            print('eslint_res', eslint_res)
            if eslint_res and hasattr(eslint_res, 'text'):
                # Parse the ESLint JSON output
                eslint_output = json.loads(eslint_res.text)
                error_lines = []
                error_messages = []
                for result in eslint_output:
                    print(eslint_output)
                    for message in result.get('messages', []):
                        line = message.get('line', 0)
                        error_lines.append(line)
                        error_messages.append(
                            f"{filepath}:{line}:{message.get('column', 0)}: {message.get('message')} ({message.get('ruleId')})"
                        )
                if not error_messages:
                    return []

                return LintResult(text='\n'.join(error_messages), lines=error_lines)
        except json.JSONDecodeError:
            # LintResult(text=f'\nJSONDecodeError: {e}', lines=[eslint_res])
            return []
        except FileNotFoundError:
            return []
        except Exception:
            # return [LintResult(text=f'\nUnexpected error: {e}', lines=[])]
            return []
    finally:
        os.unlink(temp_config_path)
    return []


def ts_tsc_lint(filepath: str) -> list[LintResult]:
    """Use typescript compiler to check for errors. If TypeScript is not installed return None."""

    if not TS_INSTALLED:
        return []

    results: list[LintResult] = []
    tsc_cmd = f'tsc --noEmit --allowJs --checkJs --strict --noImplicitAny --strictNullChecks --strictFunctionTypes --strictBindCallApply --strictPropertyInitialization --noImplicitThis --alwaysStrict {filepath}'
    try:
        tsc_res = run_cmd(tsc_cmd)
        if tsc_res:
            # Parse the TSC output
            for line in tsc_res.split('\n'):
                # Extract lines and column numbers
                if ': error TS' in line or ': warning TS' in line:
                    try:
                        location_part = line.split('(')[1].split(')')[0]
                        line_num, column = map(int, location_part.split(','))
                        results.append(
                            LintResult(
                                filepath=filepath,
                                line=line_num,
                                column=column,
                                message=line,
                            )
                        )
                    except (IndexError, ValueError):
                        continue
            return results
    except FileNotFoundError:
        pass

    # If still no errors, check for missing semicolons
    with open(filepath, 'r') as file:
        code = file.read()
    lines = code.split('\n')
    error_lines: list[int] = []
    for i, line in enumerate(lines):
        stripped_line = line.strip()
        if (
            stripped_line
            and not stripped_line.endswith(';')
            and not stripped_line.endswith('{')
            and not stripped_line.endswith('}')
            and not stripped_line.startswith('//')
        ):
            error_lines.append(i + 1)

    if error_lines:
        for line_no in error_lines:
            error_message = f"{filepath}({line_no},1): error TS1005: ';' expected."
            results.append(
                LintResult(file=filepath, line=line_no, column=1, message=error_message)
            )
        return results
    return results


class TypeScriptLinter(BaseLinter):
    @property
    def supported_extensions(self) -> list[str]:
        return ['.ts', '.tsx']

    def lint(self, file_path: str) -> list[LintResult]:
        if ESLINT_INSTALLED:
            return ts_eslint(file_path)
        elif TS_INSTALLED:
            return ts_tsc_lint(file_path)
        return []
