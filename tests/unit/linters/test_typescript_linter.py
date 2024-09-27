from openhands.linter.languages.typescript import TypeScriptLinter


def test_typescript_error_file(typescript_error_file):
    # Test Python linter
    linter = TypeScriptLinter()
    assert '.ts' in linter.supported_extensions
    assert '.tsx' in linter.supported_extensions

    # if TS_INSTALLED:
    result = linter.lint(typescript_error_file)
    print(result)
    assert isinstance(result, list) and len(result) == 0
