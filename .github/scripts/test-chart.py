"""Render chart variants and assert their Kubernetes wiring (requires Helm + PyYAML)."""
import pathlib
import subprocess
import tempfile
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
CHART = ROOT / 'charts/warroom'
IMAGE = 'ghcr.io/example/warroom'


def render(values=None, success=True):
    values = dict(values or {})
    values['image'] = {'repository': IMAGE, **values.get('image', {})}
    with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml') as file:
        yaml.safe_dump(values, file)
        file.flush()
        result = subprocess.run(
            ['helm', 'template', 'test', str(CHART), '--namespace', 'observability',
             '-f', file.name],
            text=True, capture_output=True,
        )
    if not success:
        assert result.returncode != 0, result.stdout
        return result.stderr
    if result.returncode:
        raise AssertionError(result.stderr)
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def resource(docs, kind):
    return next(doc for doc in docs if doc['kind'] == kind)


class ChartTest(unittest.TestCase):
    def test_defaults(self):
        docs = render()
        self.assertEqual({d['kind'] for d in docs}, {'ServiceAccount', 'ConfigMap', 'Deployment', 'Service'})
        deploy = resource(docs, 'Deployment')
        pod = deploy['spec']['template']['spec']
        container = pod['containers'][0]
        self.assertEqual(container['image'], IMAGE + ':0.1.0')
        self.assertFalse(pod['automountServiceAccountToken'])
        self.assertTrue(container['securityContext']['readOnlyRootFilesystem'])
        self.assertEqual(container['env'][0], {'name': 'LISTEN_ADDR', 'value': '0.0.0.0:8080'})
        self.assertEqual(container['readinessProbe']['httpGet']['path'], '/api/health')
        self.assertEqual(resource(docs, 'Service')['spec']['selector'], deploy['spec']['selector']['matchLabels'])
        self.assertTrue(set(deploy['spec']['selector']['matchLabels'].items()) <= set(deploy['spec']['template']['metadata']['labels'].items()))

    def test_custom_ports_credentials_and_ingress(self):
        docs = render({
            'containerPort': 9090, 'service': {'port': 80},
            'existingSecret': 'warroom-credentials',
            'serviceAccount': {'create': False, 'name': 'external'},
            'env': [{'name': 'ANTHROPIC_API_KEY_FILE', 'value': '/credentials/key'}],
            'envFrom': [{'secretRef': {'name': 'extra-secret'}}],
            'extraVolumes': [{'name': 'credentials', 'secret': {'secretName': 'key-file'}}],
            'extraVolumeMounts': [{'name': 'credentials', 'mountPath': '/credentials', 'readOnly': True}],
            'ingress': {'enabled': True, 'className': 'nginx', 'tls': [{'hosts': ['warroom.example.com'], 'secretName': 'tls'}]},
        })
        pod = resource(docs, 'Deployment')['spec']['template']['spec']
        container = pod['containers'][0]
        self.assertEqual(pod['serviceAccountName'], 'external')
        self.assertFalse(any(d['kind'] == 'ServiceAccount' for d in docs))
        self.assertEqual(container['ports'][0]['containerPort'], 9090)
        self.assertEqual(container['env'][0]['value'], '0.0.0.0:9090')
        self.assertIn({'secretRef': {'name': 'warroom-credentials'}}, container['envFrom'])
        self.assertIn({'secretRef': {'name': 'extra-secret'}}, container['envFrom'])
        self.assertTrue(container['volumeMounts'][0]['readOnly'])
        self.assertEqual(pod['volumes'][0]['secret']['secretName'], 'key-file')
        ingress = resource(docs, 'Ingress')['spec']
        self.assertEqual(ingress['rules'][0]['http']['paths'][0]['backend']['service']['port']['number'], 80)
        self.assertEqual(ingress['ingressClassName'], 'nginx')

    def test_extra_objects_accept_maps_and_yaml_with_root_context(self):
        docs = render({'extraObjects': [
            {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': '{{ .Release.Name }}-extra', 'namespace': '{{ .Release.Namespace }}'}, 'data': {'url': '{{ .Release.Namespace }}'}},
            'apiVersion: v1\nkind: Secret\nmetadata:\n  name: {{ include "warroom.fullname" . }}-extra\ntype: Opaque\nstringData:\n  example: non-sensitive-test\n',
        ]})
        extra = next(d for d in docs if d['metadata']['name'] == 'test-extra')
        self.assertEqual(extra['metadata']['namespace'], 'observability')
        self.assertEqual(extra['data']['url'], 'observability')
        self.assertEqual(resource(docs, 'Secret')['metadata']['name'], 'test-warroom-extra')

    def test_digest_overrides_tag_and_config_rolls_pods(self):
        before = render()
        after = render({'image': {'digest': 'sha256:' + 'a' * 64}, 'config': {'LLM_MCP_RPS': 1}})
        deploy = resource(after, 'Deployment')
        self.assertEqual(deploy['spec']['template']['spec']['containers'][0]['image'], IMAGE + '@sha256:' + 'a' * 64)
        annotation = lambda docs: resource(docs, 'Deployment')['spec']['template']['metadata']['annotations']['checksum/config']
        self.assertNotEqual(annotation(before), annotation(after))
        self.assertEqual(resource(after, 'ConfigMap')['data']['LLM_MCP_RPS'], '1')

    def test_sources_and_dashboard_volume(self):
        sources = [
            {'id': 'east', 'kind': 'metrics', 'name': 'East', 'url': 'https://metrics.example.com'},
            {'id': 'west', 'kind': 'metrics', 'name': 'West', 'url': 'https://other.example.com'},
        ]
        docs = render({'dataSources': sources, 'dashboards': {'existingConfigMap': 'deployed-dashboards'}})
        pod = resource(docs, 'Deployment')['spec']['template']['spec']
        container = pod['containers'][0]
        import json
        config = next(d for d in docs if d['metadata']['name'] == 'test-warroom-sources')
        self.assertEqual(json.loads(config['data']['sources.json']), sources)
        self.assertIn({'name': 'DATA_SOURCES_FILE', 'value': '/etc/warroom/sources/sources.json'}, container['env'])
        self.assertIn({'name': 'DASHBOARDS_DIR', 'value': '/etc/warroom/dashboards'}, container['env'])
        self.assertTrue(all(m['readOnly'] for m in container['volumeMounts']))
        self.assertIn({'name': 'dashboards', 'configMap': {'name': 'deployed-dashboards'}}, pod['volumes'])
        render({'dataSources': sources, 'dataSourcesConfigMap': 'other'}, success=False)
        render({'dashboards': {'existingConfigMap': 'a', 'existingClaim': 'b'}}, success=False)
        docs = render({'dataSourcesConfigMap': 'external', 'dashboards': {'existingClaim': 'dashboard-files'}})
        pod = resource(docs, 'Deployment')['spec']['template']['spec']
        self.assertIn({'name': 'dashboards', 'persistentVolumeClaim': {'claimName': 'dashboard-files'}}, pod['volumes'])

    def test_invalid_values_are_rejected(self):
        for values in [{'containerPort': 0}, {'replicaCount': -1}, {'extraObjects': [42]}, {'image': {'digest': 'bad'}}, {'image': {'repository': ''}}]:
            with self.subTest(values=values):
                render(values, success=False)


if __name__ == '__main__':
    subprocess.run(['helm', 'lint', '--strict', str(CHART), '--set', f'image.repository={IMAGE}'], check=True)
    unittest.main()
