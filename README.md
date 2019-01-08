# kubernetes-bootstrap [![Build Status](https://travis-ci.org/Collaborne/kubernetes-bootstrap.svg?branch=master)](https://travis-ci.org/Collaborne/kubernetes-bootstrap) [![Greenkeeper badge](https://badges.greenkeeper.io/Collaborne/kubernetes-bootstrap.svg)](https://greenkeeper.io/)

Tool for processing a set of (mustache) templates into a kubernetes cluster

## Features

* Mustache templates
* Multi-level settings (override version-controlled configuration with local configuration, and that with command line arguments)
* Somewhat intelligent handling of errors
* Support for Third-Party Resources

## Installation

```sh
npm install -g kubernetes-bootstrap
```

## Usage

kubernetes-bootstrap processes a directory containing mustache templates that create kubernetes manifests.

Assume this directory structure:
~~~~
deploy.yaml
deploy.yaml.override
templates/
  app/
    db.yml
    app.yml
  infrastructure/
    lb.yml
  aws/
    aws-resource.yml
  minikube/
    aws-resource.yml
~~~~

You can use `kubernetes-bootstrap` to process these templates and apply them to a kubernetes cluster:

```sh
kubernetes-bootstrap --template-dir templates -x aws
```

Any template parameters in the templates will be resolved against the contents of `deploy.yaml`. `deploy.yaml` must minimally contain the 'environment' field:
```yaml
environment: my-nice-environment
```

This field is used by `kubernetes-bootstrap` to create a namespace. All resources from the template directory are then apply-ed into this namespace.

## Advanced Usage

See the source and `kubernetes-bootstrap --help`.

## License

    This software is licensed under the Apache 2 license, quoted below.

    Copyright 2017-2019 Collaborne B.V. <http://github.com/Collaborne/>

    Licensed under the Apache License, Version 2.0 (the "License"); you may not
    use this file except in compliance with the License. You may obtain a copy of
    the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
    License for the specific language governing permissions and limitations under
    the License.
