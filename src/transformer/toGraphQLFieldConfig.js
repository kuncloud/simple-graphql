// @flow
const _ = require('lodash')
const Sequelize = require('sequelize')
const graphql = require('graphql')
const relay = require('graphql-relay')

const Type = require('../type')
const StringHelper = require('../utils/StringHelper')
const {toGraphQLInputFieldMap} = require('./toGraphQLInputFieldMap')
const RemoteSchema = require('../definition/RemoteSchema')
const invariant = require('../utils/invariant')
const helper = require('../utils/helper')
const toGraphQLFieldConfig = function (name, postfix, fieldType, context, interfaces, remoteWithId) {
  // console.log(`toGraphQLFieldConfig:${name},${postfix}`)
  const typeName = (path) => {
    return path.replace(/\.\$type/g, '').replace(/\[\d*\]/g, '').split('.').map(v => StringHelper.toInitialUpperCase(v)).join('')
  }

  if (graphql.isOutputType(fieldType)) {
    return {type: fieldType}
  }
  if (fieldType instanceof Type.ScalarFieldType) {
    return {type: fieldType.graphQLOutputType}
  }
  switch (fieldType) {
    case String:
      return {type: graphql.GraphQLString}
    case Number:
      return {type: graphql.GraphQLFloat}
    case Boolean:
      return {type: graphql.GraphQLBoolean}
    case Date:
      return {type: Type.GraphQLScalarTypes.Date}
    case JSON:
      return {type: Type.GraphQLScalarTypes.Json}
  }

  if (_.isArray(fieldType)) {
    const elementType = toGraphQLFieldConfig(name, postfix, fieldType[0], context).type
    const listType = new graphql.GraphQLList(elementType)
    return {
      type: listType,
      resolve: context.wrapFieldResolve({
        name: name.split('.').slice(-1)[0],
        path: name,
        $type: listType,
        resolve: async function (root, args, context, info, sgContext) {
          const fieldName = name.split('.').slice(-1)[0]
          if (typeof fieldType[0] === 'string' && sgContext.models[fieldType[0]] &&
            root[fieldName] && root[fieldName].length > 0 &&
            (typeof root[fieldName][0] === 'number' || typeof root[fieldName][0] === 'string')
          ) {
            const records = await sgContext.models[fieldType[0]].findAll({where: {id: {[Sequelize.Op.in]: root[fieldName]}}})
            const result = []
            for (let cId of root[fieldName]) {
              for (let record of records) {
                if (cId.toString() === record.id.toString()) {
                  result.push(record)
                  break
                }
              }
            }
            return result
          }
          return root[fieldName]
        }
      })
    }
  }

  if (fieldType instanceof RemoteSchema) {
    if (fieldType.name.endsWith('Id')) {
      return {
        type: graphql.GraphQLID,
        resolve: async function (root) {
          const fieldName = name.split('.').slice(-1)[0]
          const linkId = fieldName.endsWith('Id') ? fieldName : (fieldName + 'Id')
          if (root[linkId]) {
            return relay.toGlobalId(fieldType.name.substr(0, fieldType.name.length - 'Id'.length), root[linkId])
          } else {
            return null
          }
        }
      }
    } else {
      return {
        type: context.remoteGraphQLObjectType(fieldType.name)
      }
    }
  }

  if (typeof fieldType === 'string') {
    if (fieldType.endsWith('Id')) {
      return {
        type: graphql.GraphQLID,
        resolve: async function (root) {
          const fieldName = name.split('.').slice(-1)[0]
          if (root[fieldName]) {
            return relay.toGlobalId(fieldType.substr(0, fieldType.length - 'Id'.length), root[fieldName])
          } else {
            return null
          }
        }
      }
    } else if (fieldType.endsWith('Edge')) {
      return {
        type: context.edgeType(fieldType.substr(0, fieldType.length - 'Edge'.length))
      }
    } else if (fieldType.endsWith('Connection')) {
      return {
        // Add Relay Connection Args
        args: {
          after: {
            $type: String,
            description: '返回的记录应该在cursor:after之后'
          },
          first: {
            $type: Number,
            description: '指定最多返回记录的数量'
          },
          before: {
            $type: String
          },
          last: {
            $type: Number
          }
        },
        type: context.connectionType(fieldType.substr(0, fieldType.length - 'Connection'.length))
      }
    } else {
      const mgsContext = context
      return {
        type: context.graphQLObjectType(fieldType),
        resolve: context.wrapFieldResolve({
          name: name.split('.').slice(-1)[0],
          path: name,
          $type: context.graphQLObjectType(fieldType),
          resolve: async function (root, args, context, info, sgContext) {
            const fieldName = name.split('.').slice(-1)[0]
            if (_.isFunction(root['get' + StringHelper.toInitialUpperCase(fieldName)])) {
              if (root[fieldName] != null && root[fieldName].id != null) {
                return root[fieldName]
              } else {
                const upperCaseFieldName = StringHelper.toInitialUpperCase(fieldName)
                // 从dataloader取数据
                // flow报错，sgContext获取loader，用context替代
                if (mgsContext.options.dataLoader !== false && mgsContext.loaders) {
                  if (mgsContext.loaders[upperCaseFieldName] && root[fieldName + 'Id']) return mgsContext.loaders[upperCaseFieldName].load(root[fieldName + 'Id'])
                }
                return root['get' + upperCaseFieldName]()
              }
            }
            if (root && root[fieldName] && (
                typeof root[fieldName] === 'number' ||
                typeof root[fieldName] === 'string'
              )) {
              return sgContext.models[fieldType].findOne({where: {id: root[fieldName]}})
            }
            return root[fieldName]
          }
        })
      }
    }
  }

  if (fieldType instanceof Object) {
    if (fieldType['$type']) {
      const result = toGraphQLFieldConfig(name, postfix, fieldType['$type'], context)
      if (fieldType['enumValues']) {
        const values = {}
        fieldType['enumValues'].forEach(
          t => {
            values[t] = {value: t}
          }
        )
        result.type = new graphql.GraphQLEnumType({
          name: typeName(name) + postfix,
          values: values
        })
      }
      if (fieldType['required'] && !(result.type instanceof graphql.GraphQLNonNull)) {
        result.type = new graphql.GraphQLNonNull(result.type)
      }
      if (fieldType['resolve']) {
        const wrapConfig = {
          name: name.split('.').slice(-1)[0],
          path: name,
          $type: result.type,
          resolve: fieldType['resolve']
        }
        if (fieldType['config']) {
          wrapConfig['config'] = fieldType['config']
        }
        result['resolve'] = context.wrapFieldResolve(wrapConfig)
      }
      if (fieldType.args || result.args) {
        result.args = toGraphQLInputFieldMap(typeName(name), {...result.args, ...fieldType.args})
      }
      result.description = fieldType['description']
      return result
    } else {
      const objType = new graphql.GraphQLObjectType({
        name: typeName(name) + postfix,
        interfaces: interfaces,
        fields: () => {
          const fields = {}
          _.forOwn(fieldType, (value, key) => {
            if (value['$type'] && value['hidden']) {

            } else {
              if (remoteWithId && !value.isLinkField && (value['$type'] instanceof RemoteSchema) && !value['$type'].name.endsWith('Id')) {
                if (key.endsWith('Id')) {
                  throw new Error(`can't name remote field type ${value['$type'].name} as ${key}:cut off 'Id'`)
                }
                const linkId = helper.formatLinkId(key)
                fields[linkId] = {
                  type: graphql.GraphQLID,
                  resolve: async function (root) {
                    if (root[linkId]) {
                      return relay.toGlobalId(value['$type'].name, root[linkId])
                    } else {
                      return root[linkId]
                    }
                  }
                }

                context.addRemoteResolver(name, key, linkId, value['$type'].name)
              }

              if (remoteWithId &&
                (typeof value['$type'] === 'string') &&
                !value.isLinkField &&
                !value['$type'].endsWith('Id') &&
                !value['$type'].endsWith('Edge') &&
                !value['$type'].endsWith('Connection')) {
                // console.log(`generate linkId:${key}`)
                const linkId = key + 'Id'
                fields[linkId] = {
                  type: graphql.GraphQLID,
                  resolve: async function (root) {
                    if (root[linkId]) {
                      return relay.toGlobalId(value['$type'], root[linkId])
                    } else {
                      return root[linkId]
                    }
                  }
                }
              }

              invariant(!fields[key], `duplicate key exist in schema:may be auto generated key:${name} ${fieldType.name}:${key} ${value}`)
              fields[key] = toGraphQLFieldConfig(name + postfix + '.' + key, '', value, context)
            }
          })
          return fields
        }
      })
      return {
        type: objType,
        resolve: context.wrapFieldResolve({
          name: name.split('.').slice(-1)[0],
          path: name,
          $type: objType,
          resolve: async function (root) {
            return root[name.split('.').slice(-1)[0]]
          }
        })
      }
    }
  }
  throw new Error('Unsupported type: ' + fieldType)
}

module.exports = toGraphQLFieldConfig
