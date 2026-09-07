"""Exercise pure error classification without importing collector console setup."""
import ast
from pathlib import Path
import unittest

tree = ast.parse(Path(__file__).with_name('dhan_options_collector.py').read_text(encoding='utf-8-sig'))
scope = {}
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_is_throttle']
exec(compile(ast.Module(body=functions, type_ignores=[]), '<collector-errors>', 'exec'), scope)

class CollectorErrors(unittest.TestCase):
    def test_empty_error_is_not_proof_of_throttling(self):
        for error in [None, '', {}, {'error_code': None, 'error_type': None, 'error_message': None}]:
            self.assertFalse(scope['_is_throttle'](error))

    def test_only_explicit_throttling_is_retried(self):
        self.assertTrue(scope['_is_throttle']({'error_code': 'DH-904', 'error_message': 'Rate limit'}))
        self.assertFalse(scope['_is_throttle']({'error_code': 'DH-901', 'error_message': 'Invalid authentication'}))

    def test_client_is_reloaded_inside_main_loop(self):
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        loop = next(n for n in main.body if isinstance(n, ast.While))
        self.assertTrue(any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                            and n.func.id == 'build_client' for n in ast.walk(loop)))

if __name__ == '__main__': unittest.main()
